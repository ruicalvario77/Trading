import { desc, eq } from "drizzle-orm";
import { requireDb, schema, type Db } from "../db";
import { ensureSchema } from "../db/migrate";
import { loadSettings } from "../settings";
import { loadHistory } from "../backtest/data";
import { getOrder, submitMarketOrder } from "../alpaca";
import { DEAD } from "../trades";
import { buildMarket, isMonthEnd, sameWeights, type Market, type Weights } from "./market";
import { CONFIGS, LOOP_SYMBOLS, BASELINE_ID, configById } from "./families";
import { simulateWeights } from "./sim";
import { runAll, selectChampion, metaTest, leaderboard, requiredMargin, type MetaTest, type LeaderRow } from "./research";

export type ResearchResults = {
  asOf: string;
  configsTested: number;
  champion: { id: string; label: string; reason: string };
  previousChampion: string | null;
  target: Weights;
  leaderboard: LeaderRow[];
  baselineSharpe: number;
  /** How much a challenger had to beat the index by. Missing on runs before the luck correction. */
  requiredMargin?: number;
  meta: MetaTest;
};

export async function loadLoopMarket(db: Db): Promise<Market> {
  return buildMarket(await loadHistory(db, LOOP_SYMBOLS, "2016-01-01"));
}

async function getState(db: Db) {
  const [s] = await db.select().from(schema.loopState).where(eq(schema.loopState.id, 1)).limit(1);
  return s;
}

/** Re-tests the whole menu on the latest data, picks the champion, and records the run. */
export async function runResearch(db: Db, m?: Market): Promise<ResearchResults> {
  const market = m ?? (await loadLoopMarket(db));
  const state = await getState(db);
  const runs = runAll(market, 100_000);
  const t = market.calendar.length - 1;
  const sel = selectChampion(runs, t, state.champion);
  const champRun = runs.find((r) => r.def.id === sel.id)!;
  const results: ResearchResults = {
    asOf: market.calendar[t],
    configsTested: runs.length,
    champion: { id: sel.id, label: champRun.def.label, reason: sel.reason },
    previousChampion: state.champion,
    target: champRun.sim.lastTarget,
    leaderboard: leaderboard(runs, market),
    baselineSharpe: sel.scores.find((s) => s.id === BASELINE_ID)?.sharpe ?? 0,
    requiredMargin: requiredMargin(runs.length),
    meta: metaTest(runs, market),
  };
  await db.insert(schema.loopResearch).values({ results });
  await db.update(schema.loopState).set({ champion: sel.id, championReason: sel.reason, lastResearchAt: new Date(), updatedAt: new Date() }).where(eq(schema.loopState.id, 1));
  return results;
}

function lastClose(m: Market, symbol: string, t: number): number | null {
  const se = m.S.get(symbol);
  if (!se) return null;
  for (let j = t; j >= Math.max(0, t - 10); j--) {
    const k = se.idx.get(m.calendar[j]);
    if (k !== undefined) return se.bars[k].close;
  }
  return null;
}

export type LoopDailySummary = {
  status: string;
  synced?: number;
  researched?: boolean;
  champion?: string | null;
  equity?: number;
  ordersPlaced?: number;
  waitingOnOrders?: boolean;
  errors: string[];
};

/**
 * One turn of the loop, run after each close while paper trading is on:
 * record fills, value the account, re-test at month end, and move the account to the champion's holdings.
 */
export async function loopDaily(): Promise<LoopDailySummary> {
  await ensureSchema();
  const db = requireDb();
  let state = await getState(db);
  const out: LoopDailySummary = { status: state.status, errors: [] };
  if (state.status !== "paper") return out;

  // 1. Fills
  const open = await db.select().from(schema.loopOrders).where(eq(schema.loopOrders.status, "open"));
  let cash = state.cash;
  let died = false;
  out.synced = 0;
  for (const o of open) {
    try {
      const b = await getOrder(o.brokerId);
      const filledQty = Number(b.filled_qty ?? (b.status === "filled" ? o.qty : 0)) || 0;
      if (b.status !== "filled" && !DEAD.has(b.status)) continue;
      if (filledQty > 0 && b.filled_avg_price) {
        const px = Number(b.filled_avg_price);
        const [h] = await db.select().from(schema.loopHoldings).where(eq(schema.loopHoldings.symbol, o.symbol)).limit(1);
        const shares = (h?.shares ?? 0) + (o.side === "buy" ? filledQty : -filledQty);
        cash += (o.side === "buy" ? -1 : 1) * filledQty * px;
        if (shares > 0) {
          await db.insert(schema.loopHoldings).values({ symbol: o.symbol, shares }).onConflictDoUpdate({ target: schema.loopHoldings.symbol, set: { shares } });
        } else {
          await db.delete(schema.loopHoldings).where(eq(schema.loopHoldings.symbol, o.symbol));
        }
      }
      if (b.status !== "filled") died = true;
      await db.update(schema.loopOrders).set({
        status: b.status === "filled" ? "filled" : "dead", fillPrice: b.filled_avg_price ? Number(b.filled_avg_price) : null,
        filledQty, filledAt: b.filled_at ? new Date(b.filled_at) : new Date(),
      }).where(eq(schema.loopOrders.id, o.id));
      out.synced++;
    } catch (e) {
      out.errors.push(`${o.symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await db.update(schema.loopState).set({ cash, ...(died ? { appliedTarget: null } : {}), updatedAt: new Date() }).where(eq(schema.loopState.id, 1));

  // 2. Re-test at month end, or when it has never run, or after a gap.
  const m = await loadLoopMarket(db);
  const t = m.calendar.length - 1;
  const today = m.calendar[t];
  const lastResearch = state.lastResearchAt?.toISOString().slice(0, 10) ?? null;
  const stale = !state.lastResearchAt || Date.now() - state.lastResearchAt.getTime() > 35 * 86_400_000;
  if (!state.champion || stale || (isMonthEnd(m.calendar, t) && (lastResearch === null || lastResearch < today))) {
    await runResearch(db, m);
    out.researched = true;
  }
  state = await getState(db);
  out.champion = state.champion;

  // 3. Value the account.
  const holdings = await db.select().from(schema.loopHoldings);
  let equity = state.cash;
  for (const h of holdings) equity += h.shares * (lastClose(m, h.symbol, t) ?? 0);
  out.equity = equity;
  const spyClose = lastClose(m, "SPY", t) ?? 0;
  await db.insert(schema.loopEquity).values({ date: today, equity, spyClose, champion: state.champion })
    .onConflictDoUpdate({ target: schema.loopEquity.date, set: { equity, spyClose, champion: state.champion } });

  // 4. Move to the champion's holdings when they change.
  const still = await db.select({ id: schema.loopOrders.id }).from(schema.loopOrders).where(eq(schema.loopOrders.status, "open"));
  if (still.length) { out.waitingOnOrders = true; return out; }
  const def = configById(state.champion ?? BASELINE_ID) ?? configById(BASELINE_ID)!;
  const target = simulateWeights(m, def.make(m), 100_000).lastTarget;
  if (state.appliedTarget && sameWeights(target, state.appliedTarget)) return out;

  const have = new Map(holdings.map((h) => [h.symbol, h.shares]));
  const syms = new Set([...Object.keys(target), ...have.keys()]);
  const orders: { symbol: string; side: "buy" | "sell"; qty: number; px: number }[] = [];
  for (const s of syms) {
    const px = lastClose(m, s, t);
    if (!px) { out.errors.push(`${s}: no recent price`); continue; }
    const want = Math.floor(((target[s] ?? 0) * equity * 0.995) / px); // keep a small cash buffer for gaps
    const diff = want - (have.get(s) ?? 0);
    if (diff !== 0) orders.push({ symbol: s, side: diff > 0 ? "buy" : "sell", qty: Math.abs(diff), px });
  }
  orders.sort((a, b) => (a.side === b.side ? 0 : a.side === "sell" ? -1 : 1));
  out.ordersPlaced = 0;
  for (const o of orders) {
    try {
      const r = await submitMarketOrder(o.symbol, o.qty, o.side, `loop-${Date.now()}-${o.symbol}-${o.side}`);
      await db.insert(schema.loopOrders).values({ brokerId: r.id, symbol: o.symbol, side: o.side, qty: o.qty, expectedPrice: o.px, status: "open" });
      out.ordersPlaced++;
    } catch (e) {
      out.errors.push(`${o.symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!out.errors.length) await db.update(schema.loopState).set({ appliedTarget: target, updatedAt: new Date() }).where(eq(schema.loopState.id, 1));
  return out;
}

/** Turns paper trading on. The first time, it funds the loop's ledger with the account size from Settings. */
export async function startLoop(): Promise<LoopDailySummary> {
  await ensureSchema();
  const db = requireDb();
  const state = await getState(db);
  if (!state.startedAt) {
    const settings = await loadSettings();
    const m = await loadLoopMarket(db);
    const t = m.calendar.length - 1;
    await db.update(schema.loopState).set({
      status: "paper", startedAt: m.calendar[t], startEquity: settings.accountUsd, cash: settings.accountUsd,
      spyStart: lastClose(m, "SPY", t), appliedTarget: null, updatedAt: new Date(),
    }).where(eq(schema.loopState.id, 1));
  } else {
    await db.update(schema.loopState).set({ status: "paper", appliedTarget: null, updatedAt: new Date() }).where(eq(schema.loopState.id, 1));
  }
  return loopDaily();
}

export async function pauseLoop(): Promise<void> {
  await ensureSchema();
  await requireDb().update(schema.loopState).set({ status: "off", updatedAt: new Date() }).where(eq(schema.loopState.id, 1));
}

export async function latestResearch(db: Db) {
  const [r] = await db.select().from(schema.loopResearch).orderBy(desc(schema.loopResearch.id)).limit(1);
  return r ? { id: r.id, createdAt: r.createdAt, results: r.results as ResearchResults } : null;
}

export { CONFIGS };
