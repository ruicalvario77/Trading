import { and, desc, eq, gte, sql } from "drizzle-orm";
import { requireDb, schema, type Db } from "../db";
import { ensureSchema } from "../db/migrate";
import { getIntradayBars, type IntradayBar } from "../alpaca";
import { mapPool } from "../backtest/data";
import { summarizeR, type RStats } from "../stats";
import { dailyT, judge, luckBarT, type SetupVerdict } from "../setups/engine";
import { buildSessions, inSession, type Session } from "./session";
import { INTRADAY_SETUPS, INDEX_ETFS, RVOL_ORB, type ITrade } from "./setups";

/** Every intraday setup ever tested counts toward the luck bar, including the stocks-in-play breakout. */
export const INTRADAY_SETUP_COUNT = INTRADAY_SETUPS.length + 1;
export const ALL_INTRADAY = [...INTRADAY_SETUPS.map((s) => ({ id: s.id, version: s.version })), { id: RVOL_ORB.id, version: RVOL_ORB.version }];

/** The day-trading universe: the most traded stocks and ETFs, where spreads are a cent and fills are reliable. */
export const DAY_SYMBOLS = 60;
export const MIN_DAY_FORWARD_TRADES = 30;

export async function dayUniverse(db: Db): Promise<string[]> {
  const rows = await db
    .select({ s: schema.symbols.symbol })
    .from(schema.symbols)
    .where(and(eq(schema.symbols.active, true), gte(schema.symbols.lastClose, 10)))
    .orderBy(desc(schema.symbols.avgDollarVolume))
    .limit(DAY_SYMBOLS);
  const list = rows.map((r) => r.s);
  for (const s of INDEX_ETFS) if (!list.includes(s)) list.push(s);
  return list;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Fetches five-minute regular-session bars in monthly slices, a few at a time, to stay inside the rate limit. */
async function fetchSessions(symbols: string[], fromMs: number, toMs: number): Promise<Map<string, Session[]>> {
  const slices: [number, number][] = [];
  for (let a = fromMs; a < toMs; a += 31 * 86_400_000) slices.push([a, Math.min(a + 31 * 86_400_000, toMs)]);
  const parts = await mapPool(slices, 3, ([a, b]) => getIntradayBars(symbols, iso(a), iso(b), inSession));
  const merged = new Map<string, IntradayBar[]>();
  for (const p of parts) for (const [s, bars] of Object.entries(p)) (merged.get(s) ?? merged.set(s, []).get(s)!).push(...bars);
  const out = new Map<string, Session[]>();
  for (const [s, bars] of merged) out.set(s, buildSessions(s, bars.sort((x, y) => x.ts - y.ts)));
  return out;
}

export type IntradaySetupResult = {
  id: string;
  version: string;
  edge: RStats;
  t: number;
  days: number;
  earlier: RStats;
  later: RStats;
  verdict: SetupVerdict;
  exits: Record<string, number>;
  byEntryHour: { hour: string; trades: number; avgR: number }[];
  perMonth: { month: string; trades: number; avgR: number }[];
  recent: ITrade[];
};

export type IntradayResults = {
  /** "core" for the per-session setups, "rvol" for the stocks-in-play breakout. Missing means core. */
  kind?: "core" | "rvol";
  from: string;
  to: string;
  months: number;
  symbols: number;
  sessions: number;
  luckBar: number;
  setups: IntradaySetupResult[];
};

/** Statistics for one setup's trades, shared by both pipelines. */
export function intradaySetupResult(id: string, version: string, ts: ITrade[]): IntradaySetupResult {
  ts = [...ts].sort((a, b) => a.date.localeCompare(b.date) || a.entryM - b.entryM);
  const dates = ts.map((t) => t.date);
  const mid = dates.length ? new Date((Date.parse(dates[0]) + Date.parse(dates[dates.length - 1])) / 2).toISOString().slice(0, 10) : "";
  const group = (key: (t: ITrade) => string) => {
    const m = new Map<string, number[]>();
    for (const t of ts) (m.get(key(t)) ?? m.set(key(t), []).get(key(t))!).push(t.r);
    return [...m].sort(([a], [b]) => a.localeCompare(b)).map(([k, rs]) => ({ k, trades: rs.length, avgR: rs.reduce((a, b) => a + b, 0) / rs.length }));
  };
  const edge = summarizeR(ts.map((t) => t.r));
  const { t, days } = dailyT(ts.map((x) => ({ entryDate: x.date, r: x.r })));
  const earlier = summarizeR(ts.filter((x) => x.date < mid).map((x) => x.r));
  const later = summarizeR(ts.filter((x) => x.date >= mid).map((x) => x.r));
  const exits: Record<string, number> = {};
  for (const x of ts) exits[x.reason] = (exits[x.reason] ?? 0) + 1;
  return {
    id, version, edge, t, days, earlier, later, verdict: judge(edge, t, earlier, later, INTRADAY_SETUP_COUNT), exits,
    byEntryHour: group((x) => String(Math.floor(x.entryM / 60)).padStart(2, "0")).map(({ k, ...r }) => ({ hour: `${k}:00`, ...r })),
    perMonth: group((x) => x.date.slice(0, 7)).map(({ k, ...r }) => ({ month: k, ...r })),
    recent: ts.slice(-12).reverse(),
  };
}

/** Every intraday setup on every session from `from`, without the database. */
export function computeIntraday(sessions: Map<string, Session[]>, from: string, months: number): IntradayResults {
  const trades = new Map<string, ITrade[]>(INTRADAY_SETUPS.map((s) => [s.id, []]));
  let count = 0;
  let first = "9999";
  let last = "0000";
  for (const list of sessions.values()) {
    for (const s of list) {
      if (s.date < from) continue;
      count++;
      if (s.date < first) first = s.date;
      if (s.date > last) last = s.date;
      for (const setup of INTRADAY_SETUPS) {
        const t = setup.run(s);
        if (t) trades.get(setup.id)!.push(t);
      }
    }
  }
  return {
    kind: "core", from: first, to: last, months, symbols: sessions.size, sessions: count, luckBar: luckBarT(INTRADAY_SETUP_COUNT),
    setups: INTRADAY_SETUPS.map((s) => intradaySetupResult(s.id, s.version, trades.get(s.id)!)),
  };
}

/** Backtests the intraday setups over the last `months` months on the day-trading universe. */
export async function runIntradayResearch(months: number): Promise<number> {
  await ensureSchema();
  const db = requireDb();
  const symbols = await dayUniverse(db);
  const now = Date.now();
  const from = new Date(now - months * 30.4 * 86_400_000).toISOString().slice(0, 10);
  // Forty extra days so each stock's normal opening volume is known from the first test day.
  const sessions = await fetchSessions(symbols, now - (months * 30.4 + 40) * 86_400_000, now);
  const results = computeIntraday(sessions, from, months);
  const [row] = await db.insert(schema.intradayRuns).values({ results }).returning({ id: schema.intradayRuns.id });
  return row.id;
}

export type IntradayForwardSummary = { recordedDays: string[]; trades: number; skipped?: string };

/**
 * Morning job: replays every session since the last recorded one (up to about five weeks back) with all
 * intraday setups and stores the trades. The first run records only the latest session.
 */
export async function recordIntradayForward(): Promise<IntradayForwardSummary> {
  await ensureSchema();
  const db = requireDb();
  const symbols = await dayUniverse(db);
  if (symbols.length < 10) return { recordedDays: [], trades: 0, skipped: "universe not built yet" };
  const now = Date.now();
  const sessions = await fetchSessions(symbols, now - 40 * 86_400_000, now);
  const dates = [...new Set([...sessions.values()].flatMap((l) => l.map((s) => s.date)))].sort();
  if (!dates.length) return { recordedDays: [], trades: 0, skipped: "no sessions returned" };
  const [lastDone] = await db.select({ d: sql<string | null>`max(${schema.intradayDays.date})` }).from(schema.intradayDays);
  const todo = lastDone?.d ? dates.filter((d) => d > lastDone.d!) : [dates[dates.length - 1]];
  let total = 0;
  for (const date of todo) {
    const rows: (typeof schema.intradayForward.$inferInsert)[] = [];
    let n = 0;
    for (const list of sessions.values()) {
      const s = list.find((x) => x.date === date);
      if (!s || s.bars.length < 30) continue; // skip half-empty days (data gaps)
      n++;
      for (const setup of INTRADAY_SETUPS) {
        const t = setup.run(s);
        if (t) rows.push({ setup: t.setup, version: setup.version, symbol: t.symbol, date, entryM: t.entryM, exitM: t.exitM, entry: t.entry, exit: t.exit, stop: t.stop, r: t.r, reason: t.reason });
      }
    }
    if (rows.length) await db.insert(schema.intradayForward).values(rows).onConflictDoNothing();
    await db.insert(schema.intradayDays).values({ date, symbols: n, trades: rows.length }).onConflictDoNothing();
    total += rows.length;
  }
  return { recordedDays: todo, trades: total };
}

export type IntradayForwardStats = { id: string; version: string; trades: RStats; t: number; days: number };

export async function intradayForwardStats(db: Db): Promise<{ stats: IntradayForwardStats[]; daysRecorded: number; firstDay: string | null; lastDay: string | null }> {
  const rows = await db.select().from(schema.intradayForward);
  const [d] = await db.select({ n: sql<number>`count(*)::int`, a: sql<string | null>`min(${schema.intradayDays.date})`, b: sql<string | null>`max(${schema.intradayDays.date})` }).from(schema.intradayDays);
  return {
    daysRecorded: d.n, firstDay: d.a, lastDay: d.b,
    stats: ALL_INTRADAY.map((s) => {
      const mine = rows.filter((r) => r.setup === s.id && r.version === s.version).sort((a, b) => a.date.localeCompare(b.date) || a.entryM - b.entryM);
      const { t, days } = dailyT(mine.map((r) => ({ entryDate: r.date, r: r.r })));
      return { id: s.id, version: s.version, trades: summarizeR(mine.map((r) => r.r)), t, days };
    }),
  };
}
