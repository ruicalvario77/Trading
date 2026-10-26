import { eq, gte, inArray } from "drizzle-orm";
import { requireDb, schema, type Db } from "../db";
import { ensureSchema } from "../db/migrate";
import { loadSettings } from "../settings";
import { loadHistory } from "../backtest/data";
import { summarizeR, type RStats } from "../stats";
import type { OHLCV } from "../indicators";
import { marketHistoryStart } from "../jobs/universe";
import { SETUPS, MIN_BARS, marketCtx, prepare, type Plan } from "./library";
import { backtestSymbol, dailyT, judge, planProblem, runPlan, luckBarT, type SetupFunnel, type SetupTrade, type SetupVerdict } from "./engine";

export type SetupResult = {
  id: string;
  version: string;
  edge: RStats;
  t: number;
  days: number;
  earlier: RStats;
  later: RStats;
  verdict: SetupVerdict;
  funnel: SetupFunnel;
  exitReasons: Record<string, number>;
  perYear: { year: string; trades: number; avgR: number }[];
  recent: SetupTrade[];
};

export type SetupRunResults = {
  firstDate: string;
  lastDate: string;
  midDate: string;
  symbols: number;
  luckBar: number;
  setups: SetupResult[];
};

async function activeSymbols(db: Db): Promise<string[]> {
  return (await db.select({ s: schema.symbols.symbol }).from(schema.symbols).where(eq(schema.symbols.active, true))).map((r) => r.s);
}

/** Backtests every setup on every active symbol over the stored history (about four years). */
export async function runSetupLab(): Promise<number> {
  await ensureSchema();
  const db = requireDb();
  const settings = await loadSettings();
  const bars = await loadHistory(db, await activeSymbols(db), marketHistoryStart());
  const results = computeSetupLab(bars, { minPrice: settings.minPrice, maxPrice: settings.maxPrice });
  const [row] = await db.insert(schema.setupRuns).values({ results }).returning({ id: schema.setupRuns.id });
  return row.id;
}

/** Every setup on every symbol, without the database. */
export function computeSetupLab(bars: Map<string, OHLCV[]>, lim: { minPrice: number; maxPrice: number }): SetupRunResults {
  const spy = bars.get("SPY");
  if (!spy) throw new Error("No SPY history. Load history first.");
  const ctx = marketCtx(spy);

  const all = new Map<string, SetupTrade[]>(SETUPS.map((s) => [s.id, []]));
  const funnels = new Map<string, SetupFunnel>(SETUPS.map((s) => [s.id, { signals: 0, rejected: {}, unfilled: 0, entered: 0 }]));
  let firstDate = "9999";
  let lastDate = "0000";
  let used = 0;
  for (const [symbol, b] of bars) {
    if (b.length < MIN_BARS + 20) continue;
    used++;
    if (b[MIN_BARS].date < firstDate) firstDate = b[MIN_BARS].date;
    if (b[b.length - 1].date > lastDate) lastDate = b[b.length - 1].date;
    const d = prepare(b);
    for (const s of SETUPS) {
      const { trades, funnel } = backtestSymbol(s, symbol, d, ctx, lim);
      all.get(s.id)!.push(...trades);
      const f = funnels.get(s.id)!;
      f.signals += funnel.signals; f.unfilled += funnel.unfilled; f.entered += funnel.entered;
      for (const [k, n] of Object.entries(funnel.rejected)) f.rejected[k] = (f.rejected[k] ?? 0) + n;
    }
  }
  const midDate = new Date((Date.parse(firstDate) + Date.parse(lastDate)) / 2).toISOString().slice(0, 10);

  const setups: SetupResult[] = SETUPS.map((s) => {
    const trades = all.get(s.id)!.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
    const edge = summarizeR(trades.map((t) => t.r));
    const { t, days } = dailyT(trades);
    const earlier = summarizeR(trades.filter((x) => x.entryDate < midDate).map((x) => x.r));
    const later = summarizeR(trades.filter((x) => x.entryDate >= midDate).map((x) => x.r));
    const exitReasons: Record<string, number> = {};
    for (const x of trades) exitReasons[x.reason] = (exitReasons[x.reason] ?? 0) + 1;
    const years = new Map<string, number[]>();
    for (const x of trades) (years.get(x.entryDate.slice(0, 4)) ?? years.set(x.entryDate.slice(0, 4), []).get(x.entryDate.slice(0, 4))!).push(x.r);
    return {
      id: s.id, version: s.version, edge, t, days, earlier, later,
      verdict: judge(edge, t, earlier, later, SETUPS.length),
      funnel: funnels.get(s.id)!, exitReasons,
      perYear: [...years].sort(([a], [b]) => a.localeCompare(b)).map(([year, rs]) => ({ year, trades: rs.length, avgR: rs.reduce((a, b) => a + b, 0) / rs.length })),
      recent: trades.slice(-12).reverse(),
    };
  });

  return { firstDate, lastDate, midDate, symbols: used, luckBar: luckBarT(SETUPS.length), setups };
}

export type TrackSummary = { updated: number; closed: number; newSignals: number; signalDate: string | null; skipped?: string };

/**
 * Nightly forward record. First moves every pending or open signal forward with the newest bars, then records
 * today's signals from every setup on every active symbol. Nothing here places orders.
 */
export async function trackSetups(history?: Map<string, OHLCV[]>): Promise<TrackSummary> {
  await ensureSchema();
  const db = requireDb();
  const settings = await loadSettings();
  const lim = { minPrice: settings.minPrice, maxPrice: settings.maxPrice };
  const out: TrackSummary = { updated: 0, closed: 0, newSignals: 0, signalDate: null };

  const since = new Date(Date.now() - 460 * 86_400_000).toISOString().slice(0, 10);
  const bars = history ?? (await loadHistory(db, await activeSymbols(db), since));

  // 1. Follow live signals forward.
  const live = await db.select().from(schema.shadowSignals).where(inArray(schema.shadowSignals.status, ["pending", "open"]));
  for (const s of live) {
    const b = bars.get(s.symbol);
    if (!b) continue;
    const i = b.findIndex((x) => x.date === s.signalDate);
    if (i < 0) continue;
    const o = runPlan(b, i, s.plan as unknown as Plan, false);
    const next =
      o.status === "unfilled" ? { status: "unfilled" } :
      o.status === "open" ? (o.f < 0 ? { status: "pending" } : { status: "open", entryDate: b[o.f].date, entry: o.entry }) :
      { status: "closed", entryDate: b[o.f].date, exitDate: b[o.x].date, entry: o.entry, exit: o.exit, r: o.r, reason: o.reason };
    if (next.status === s.status && next.status !== "open") continue;
    await db.update(schema.shadowSignals).set({ ...next, updatedAt: new Date() }).where(eq(schema.shadowSignals.id, s.id));
    out.updated++;
    if (next.status === "closed") out.closed++;
  }

  // 2. Record today's signals.
  const spy = bars.get("SPY");
  if (!spy?.length) { out.skipped = "no SPY data"; return out; }
  const today = spy[spy.length - 1].date;
  out.signalDate = today;
  const [already] = await db.select({ id: schema.shadowSignals.id }).from(schema.shadowSignals).where(eq(schema.shadowSignals.signalDate, today)).limit(1);
  if (already) { out.skipped = "today's signals already recorded"; return out; }
  const ctx = marketCtx(spy);
  const rows: (typeof schema.shadowSignals.$inferInsert)[] = [];
  for (const [symbol, b] of bars) {
    if (b.length < MIN_BARS + 1 || b[b.length - 1].date !== today) continue;
    const d = prepare(b);
    const i = b.length - 1;
    for (const s of SETUPS) {
      const p = s.detect(d, i, ctx);
      if (!p || planProblem(p, lim)) continue;
      rows.push({ setup: s.id, version: s.version, symbol, signalDate: today, plan: p as unknown as Record<string, unknown>, score: p.score, why: p.why, status: "pending" });
    }
  }
  for (let k = 0; k < rows.length; k += 500) await db.insert(schema.shadowSignals).values(rows.slice(k, k + 500)).onConflictDoNothing();
  out.newSignals = rows.length;
  return out;
}

export type ForwardStats = { id: string; version: string; signals: number; open: number; closed: RStats; t: number; firstDate: string | null };

/** Forward results per setup from the shadow record. */
export async function forwardStats(db: Db): Promise<ForwardStats[]> {
  const rows = await db.select({
    setup: schema.shadowSignals.setup, version: schema.shadowSignals.version, status: schema.shadowSignals.status,
    r: schema.shadowSignals.r, entryDate: schema.shadowSignals.entryDate, signalDate: schema.shadowSignals.signalDate,
  }).from(schema.shadowSignals).where(gte(schema.shadowSignals.signalDate, "2000-01-01"));
  return SETUPS.map((s) => {
    const mine = rows.filter((r) => r.setup === s.id && r.version === s.version);
    const closed = mine.filter((r) => r.status === "closed" && r.r !== null).sort((a, b) => (a.entryDate ?? "").localeCompare(b.entryDate ?? ""));
    return {
      id: s.id, version: s.version, signals: mine.length,
      open: mine.filter((r) => r.status === "open").length,
      closed: summarizeR(closed.map((r) => r.r!)),
      t: dailyT(closed.map((r) => ({ entryDate: r.entryDate ?? r.signalDate, r: r.r! }))).t,
      firstDate: mine.length ? mine.map((r) => r.signalDate).sort()[0] : null,
    };
  });
}

