import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { requireDb, schema } from "../db";
import { cancelOrder, getOrder, submitBracketOrder } from "../alpaca";
import { ENTRY_EXPIRY_DAYS, entryLimitFor, limitBlock, reconcileTrade, weekStartUtc } from "../trades";
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
  const [scan] = await db.select().from(schema.scans).orderBy(desc(schema.scans.id)).limit(1);
  const out: PlaceSummary = { tradeDate: scan?.tradeDate ?? null, approved: 0, placed: 0, blocked: 0, failed: 0, errors: [] };
  if (!scan) return out;

  // Approvals from older scans describe setups that no longer exist.
  await db
    .update(schema.candidates)
    .set({ status: "expired" })
    .where(and(eq(schema.candidates.status, "approved"), sql`${schema.candidates.tradeDate} < ${scan.tradeDate}`));

  const approved = await db
    .select()
    .from(schema.candidates)
    .where(and(eq(schema.candidates.status, "approved"), eq(schema.candidates.tradeDate, scan.tradeDate)))
    .orderBy(desc(schema.candidates.score));
  out.approved = approved.length;
  const pnl = await weekPnl();

  for (const c of approved) {
    const [t] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.trades).where(inArray(schema.trades.status, ["pending_entry", "open"]));
    const block = limitBlock({ committed: t.n, maxPositions: settings.maxPositions, weekPnlUsd: pnl, accountUsd: settings.accountUsd, weeklyLossLimitPct: settings.weeklyLossLimitPct });
    if (block || !c.tradeable || !c.entry || !c.stop || !c.target || !c.shares || !c.riskUsd) {
      await db.update(schema.candidates).set({ status: "blocked", reasons: [...c.reasons, block ?? "plan incomplete"] }).where(eq(schema.candidates.id, c.id));
      out.blocked++;
      continue;
    }
    try {
      const order = await submitBracketOrder({
        symbol: c.symbol, qty: c.shares, entryStop: c.entry, entryLimit: entryLimitFor(c.entry),
        takeProfit: c.target, stopLoss: c.stop, clientOrderId: `cand-${c.id}`,
      });
      await db.insert(schema.trades).values({
        candidateId: c.id, symbol: c.symbol, status: "pending_entry", plannedEntry: c.entry, plannedStop: c.stop,
        plannedTarget: c.target, shares: c.shares, riskUsd: c.riskUsd, currentStop: c.stop, brokerOrderId: order.id,
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
