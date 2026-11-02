import { and, desc, eq, gte } from "drizzle-orm";
import { requireDb, schema, type Db } from "../db";
import { ensureSchema } from "../db/migrate";
import { getIntradayBars, type IntradayBar } from "../alpaca";
import { loadHistory, mapPool } from "../backtest/data";
import { atrSeries, smaSeries, type OHLCV } from "../indicators";
import { buildSessions, inSession, nyOffsetMinutes } from "./session";
import { RVOL_ORB, runRvolOrb, type ITrade } from "./setups";
import { intradaySetupResult, INTRADAY_SETUP_COUNT, type IntradayResults } from "./run";
import { luckBarT } from "../setups/engine";

export const RVOL_UNIVERSE = 500;
export const RVOL_TOP = 20;
export const RVOL_MAX_MONTHS = 3;

export type DayCtx = { atr: number; vol14: number };

/** For each symbol and trading date, its 14-day ATR and average daily volume as of the previous close. */
export function dailyContext(daily: Map<string, OHLCV[]>): Map<string, Map<string, DayCtx>> {
  const out = new Map<string, Map<string, DayCtx>>();
  for (const [s, b] of daily) {
    const atr = atrSeries(b, 14);
    const vol = smaSeries(b.map((x) => x.volume), 14);
    const m = new Map<string, DayCtx>();
    for (let i = 0; i + 1 < b.length; i++) {
      const a = atr[i];
      const v = vol[i];
      if (a !== null && v !== null) m.set(b[i + 1].date, { atr: a, vol14: v });
    }
    out.set(s, m);
  }
  return out;
}

/** The day's 20 stocks in play: biggest first-five-minute volume relative to normal daily volume. */
export function pickInPlay(first: Record<string, IntradayBar | undefined>, ctx: Map<string, Map<string, DayCtx>>, date: string): string[] {
  const ranked: { s: string; rv: number }[] = [];
  for (const [s, bar] of Object.entries(first)) {
    const c = ctx.get(s)?.get(date);
    if (!bar || !c || bar.o < 5 || c.vol14 < 1_000_000 || c.atr < 0.5) continue;
    ranked.push({ s, rv: bar.v / c.vol14 });
  }
  return ranked.sort((a, b) => b.rv - a.rv).slice(0, RVOL_TOP).map((x) => x.s);
}

export function openUtc(date: string): number {
  return Date.parse(`${date}T09:30:00Z`) - nyOffsetMinutes(Date.parse(`${date}T12:00:00Z`)) * 60_000;
}

/** One trading day: rank the universe on its first bar, then follow the in-play stocks through the session. */
export async function rvolDay(symbols: string[], date: string, ctx: Map<string, Map<string, DayCtx>>): Promise<{ picks: string[]; trades: ITrade[] }> {
  const open = openUtc(date);
  const raw = await getIntradayBars(symbols, new Date(open).toISOString(), new Date(open + 60_000).toISOString());
  const first: Record<string, IntradayBar | undefined> = {};
  for (const [s, bars] of Object.entries(raw)) first[s] = bars.find((b) => b.ts === open);
  const picks = pickInPlay(first, ctx, date);
  if (!picks.length) return { picks, trades: [] };
  const full = await getIntradayBars(picks, new Date(open).toISOString(), new Date(open + 390 * 60_000).toISOString(), inSession);
  const trades: ITrade[] = [];
  for (const s of picks) {
    const sess = buildSessions(s, full[s] ?? []).find((x) => x.date === date);
    const c = ctx.get(s)?.get(date);
    if (!sess || !c) continue;
    const t = runRvolOrb(sess, c.atr);
    if (t) trades.push(t);
  }
  return { picks, trades };
}

async function rvolUniverse(db: Db): Promise<string[]> {
  return (await db.select({ s: schema.symbols.symbol }).from(schema.symbols)
    .where(and(eq(schema.symbols.active, true), gte(schema.symbols.lastClose, 5)))
    .orderBy(desc(schema.symbols.avgDollarVolume)).limit(RVOL_UNIVERSE)).map((r) => r.s);
}

/** Backtest of the stocks-in-play breakout over the last few months (capped by the data plan's request limit). */
export async function runRvolResearch(months: number): Promise<number> {
  await ensureSchema();
  const db = requireDb();
  months = Math.min(months, RVOL_MAX_MONTHS);
  const symbols = await rvolUniverse(db);
  const from = new Date(Date.now() - months * 30.4 * 86_400_000).toISOString().slice(0, 10);
  const daily = await loadHistory(db, [...new Set([...symbols, "SPY"])], new Date(Date.now() - (months * 30.4 + 45) * 86_400_000).toISOString().slice(0, 10));
  const dates = (daily.get("SPY") ?? []).map((b) => b.date).filter((d) => d >= from);
  const ctx = dailyContext(daily);
  const days = await mapPool(dates, 2, (d) => rvolDay(symbols, d, ctx));
  const trades = days.flatMap((d) => d.trades);
  const results: IntradayResults = {
    kind: "rvol", from: dates[0] ?? from, to: dates[dates.length - 1] ?? from, months, symbols: symbols.length, sessions: days.reduce((a, d) => a + d.picks.length, 0),
    luckBar: luckBarT(INTRADAY_SETUP_COUNT), setups: [intradaySetupResult(RVOL_ORB.id, RVOL_ORB.version, trades)],
  };
  const [row] = await db.insert(schema.intradayRuns).values({ results }).returning({ id: schema.intradayRuns.id });
  return row.id;
}

/** Morning job: the stocks-in-play breakout on the previous session, if not recorded yet. */
export async function recordRvolForward(): Promise<{ date: string | null; picks: number; trades: number; skipped?: string }> {
  await ensureSchema();
  const db = requireDb();
  const symbols = await rvolUniverse(db);
  if (symbols.length < 50) return { date: null, picks: 0, trades: 0, skipped: "universe not built yet" };
  const daily = await loadHistory(db, [...new Set([...symbols, "SPY"])], new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10));
  const spy = daily.get("SPY") ?? [];
  const date = spy[spy.length - 1]?.date ?? null;
  if (!date) return { date, picks: 0, trades: 0, skipped: "no SPY data" };
  const [done] = await db.select({ d: schema.intradayRvolDays.date }).from(schema.intradayRvolDays).where(eq(schema.intradayRvolDays.date, date)).limit(1);
  if (done) return { date, picks: 0, trades: 0, skipped: "already recorded" };
  const { picks, trades } = await rvolDay(symbols, date, dailyContext(daily));
  if (trades.length) {
    await db.insert(schema.intradayForward).values(trades.map((t) => ({
      setup: t.setup, version: RVOL_ORB.version, symbol: t.symbol, date, entryM: t.entryM, exitM: t.exitM, entry: t.entry, exit: t.exit, stop: t.stop, r: t.r, reason: t.reason,
    }))).onConflictDoNothing();
  }
  await db.insert(schema.intradayRvolDays).values({ date, picks: picks.length, trades: trades.length }).onConflictDoNothing();
  return { date, picks: picks.length, trades: trades.length };
}

