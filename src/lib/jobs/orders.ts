import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { requireDb, schema } from "../db";
import { cancelOrder, getOrder, submitBracketOrder, submitMarketSell } from "../alpaca";
import { ENTRY_EXPIRY_DAYS, OPEN_ORDER_STATUSES, entryLimitFor, limitBlock, reconcileExitOrder, reconcileTrade, weekStartUtc } from "../trades";
import type { Settings } from "../db/schema";

export async function weekPnl(): Promise<number> {
  const db = requireDb();
  const [row] = await db
    .select({ pnl: sql<number>`coalesce(sum(${schema.trades.pnlUsd}), 0)::float` })
    .from(schema.trades)
    .where(and(eq(schema.trades.status, "closed"), gte(schema.trades.exitedAt, weekStartUtc(new Date()))));
  return row.pnl;
}

/** Approved candidates plus pending entries plus open positions. */
export async function committedCount(): Promise<number> {
  const db = requireDb();
  const [t] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.trades).where(inArray(schema.trades.status, ["pending_entry", "open"]));
  const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.candidates).where(eq(schema.candidates.status, "approved"));
  return t.n + c.n;
}

export type SyncSummary = { checked: number; filled: number; closed: number; cancelled: number; expired: number; errors: string[] };

/** Pulls the state of every live bracket order from the broker and updates the trades table. */
export async function syncTrades(): Promise<SyncSummary> {
  const db = requireDb();
  const live = await db.select().from(schema.trades).where(inArray(schema.trades.status, ["pending_entry", "open"]));
  const out: SyncSummary = { checked: 0, filled: 0, closed: 0, cancelled: 0, expired: 0, errors: [] };
  const expiryMs = ENTRY_EXPIRY_DAYS * 86_400_000;

  for (const t of live) {
    if (!t.brokerOrderId) continue;
    out.checked++;
    try {
      if (t.exitOrderId) {
        const u = reconcileExitOrder(t, await getOrder(t.exitOrderId));
        if (u) {
          await db.update(schema.trades).set({ ...u, updatedAt: new Date() }).where(eq(schema.trades.id, t.id));
          if (u.status === "closed") out.closed++;
        }
        continue;
      }
      let order = await getOrder(t.brokerOrderId);
      if (t.status === "pending_entry" && order.status !== "filled" && Date.now() - t.createdAt.getTime() > expiryMs) {
        await cancelOrder(t.brokerOrderId);
        order = await getOrder(t.brokerOrderId);
        if (order.status !== "filled") {
          await db.update(schema.trades).set({ status: "cancelled", exitReason: "entry_expired", updatedAt: new Date() }).where(eq(schema.trades.id, t.id));
          out.expired++;
          continue;
        }
      }
      const u = reconcileTrade(t, order);
      if (!u) continue;
      await db.update(schema.trades).set({ ...u, updatedAt: new Date() }).where(eq(schema.trades.id, t.id));
      if (u.entryFill !== undefined) out.filled++;
      if (u.status === "closed") out.closed++;
      if (u.status === "cancelled") out.cancelled++;
    } catch (e) {
      out.errors.push(`${t.symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

export type PlaceSummary = { tradeDate: string | null; approved: number; placed: number; blocked: number; failed: number; errors: string[] };

/** Sends a bracket order for each approved candidate from the latest scan, within the account limits. */
export async function placeApproved(settings: Settings): Promise<PlaceSummary> {
  const db = requireDb();
  // The newest signal date with approvals is the one to trade; anything older no longer describes the market.
  const [latest] = await db.select({ d: sql<string | null>`max(${schema.candidates.tradeDate})` }).from(schema.candidates).where(eq(schema.candidates.status, "approved"));
  const tradeDate = latest?.d ?? null;
  const out: PlaceSummary = { tradeDate, approved: 0, placed: 0, blocked: 0, failed: 0, errors: [] };
  if (!tradeDate) return out;
  await db
    .update(schema.candidates)
    .set({ status: "expired" })
    .where(and(eq(schema.candidates.status, "approved"), sql`${schema.candidates.tradeDate} < ${tradeDate}`));

  const approved = await db
    .select()
    .from(schema.candidates)
    .where(and(eq(schema.candidates.status, "approved"), eq(schema.candidates.tradeDate, tradeDate)))
    .orderBy(desc(schema.candidates.score));
  out.approved = approved.length;
  const pnl = await weekPnl();

  for (const c of approved) {
    const [t] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.trades).where(inArray(schema.trades.status, ["pending_entry", "open"]));
    const block = limitBlock({ committed: t.n, maxPositions: settings.maxPositions, weekPnlUsd: pnl, accountUsd: settings.accountUsd, weeklyLossLimitPct: settings.weeklyLossLimitPct });
    const entryType = (c.plan as { entryType?: "stop" | "open" } | null)?.entryType ?? "stop";
    if (block || !c.tradeable || !c.entry || !c.stop || (entryType === "stop" && !c.target && !c.plan) || !c.shares || !c.riskUsd) {
      await db.update(schema.candidates).set({ status: "blocked", reasons: [...c.reasons, block ?? "plan incomplete"] }).where(eq(schema.candidates.id, c.id));
      out.blocked++;
      continue;
    }
    try {
      const order = await submitBracketOrder({
        symbol: c.symbol, qty: c.shares, entryStop: c.entry, entryLimit: entryLimitFor(c.entry),
        takeProfit: c.target ?? null, stopLoss: c.stop, clientOrderId: `cand-${c.id}`, entryType,
      });
      await db.insert(schema.trades).values({
        candidateId: c.id, symbol: c.symbol, setup: c.setup ?? "pullback", status: "pending_entry", plannedEntry: c.entry, plannedStop: c.stop,
        plannedTarget: c.target ?? null, shares: c.shares, riskUsd: c.riskUsd, currentStop: c.stop, brokerOrderId: order.id, plan: c.plan ?? null,
      });
      await db.update(schema.candidates).set({ status: "ordered" }).where(eq(schema.candidates.id, c.id));
      out.placed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.update(schema.candidates).set({ status: "failed", reasons: [...c.reasons, msg.slice(0, 200)] }).where(eq(schema.candidates.id, c.id));
      out.failed++;
      out.errors.push(`${c.symbol}: ${msg}`);
    }
  }
  return out;
}

export type TimeStopSummary = { checked: number; exiting: number; errors: string[] };

/**
 * Exits open trades that have been held for the time-stop number of trading days: cancels the bracket's
 * stop and target, then queues a market sell for the next open. Runs after the close.
 */
export async function applyTimeStops(settings: Settings): Promise<TimeStopSummary> {
  const db = requireDb();
  const open = await db.select().from(schema.trades).where(eq(schema.trades.status, "open"));
  const out: TimeStopSummary = { checked: 0, exiting: 0, errors: [] };
  for (const t of open) {
    if (!t.enteredAt || !t.brokerOrderId || t.exitOrderId) continue;
    out.checked++;
    const entered = t.enteredAt.toISOString().slice(0, 10);
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.bars)
      .where(and(eq(schema.bars.symbol, "SPY"), sql`${schema.bars.date} > ${entered}`));
    const plan = (t.plan ?? {}) as { timeStopDays?: number; exitOnStrongClose?: boolean };
    const timeStop = plan.timeStopDays ?? settings.timeStopDays;
    // Same count as the backtest: the entry day is day 1, and the sale happens at the next open.
    let due = row.n + 1 >= timeStop;
    if (!due && plan.exitOnStrongClose) {
      const last2 = await db.select().from(schema.bars).where(eq(schema.bars.symbol, t.symbol)).orderBy(desc(schema.bars.date)).limit(2);
      due = last2.length === 2 && last2[0].date >= entered && last2[0].close > last2[1].high;
    }
    if (!due) continue;
    try {
      let order = await getOrder(t.brokerOrderId);
      for (const leg of order.legs ?? []) if (OPEN_ORDER_STATUSES.has(leg.status)) await cancelOrder(leg.id);
      for (let k = 0; k < 8; k++) {
        order = await getOrder(t.brokerOrderId);
        if (!(order.legs ?? []).some((l) => OPEN_ORDER_STATUSES.has(l.status) || l.status === "pending_cancel")) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      // A stop or target filled first: the normal sync closes it.
      if ((order.legs ?? []).some((l) => l.status === "filled")) continue;
      const sell = await submitMarketSell(t.symbol, t.shares, `time-${t.id}-${Date.now()}`);
      await db.update(schema.trades).set({ exitOrderId: sell.id, updatedAt: new Date() }).where(eq(schema.trades.id, t.id));
      out.exiting++;
    } catch (e) {
      out.errors.push(`${t.symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
