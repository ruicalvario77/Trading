import { eq } from "drizzle-orm";
import { requireDb, schema } from "../db";
import { ensureSchema } from "../db/migrate";
import { loadSettings } from "../settings";
import { smaSeries, type OHLCV } from "../indicators";
import type { Settings } from "../db/schema";
import { UNIVERSE } from "../universe";
import { simulateSymbol, runPortfolio } from "../backtest/engine";
import { loadHistory } from "../backtest/data";
import { windowMetrics, markToMarket, sampleCurve, type Metrics, type CurvePoint, type LabTrade } from "./metrics";
import {
  STRATEGIES, SPLIT_DATE, BUILD_END, LAB_NOTIONAL, LAB_SLIPPAGE_PCT, simulateRotation, simulateMeanReversion,
} from "./strategies";

export type LabStrategyResult = {
  id: string;
  version: string;
  build: Metrics;
  holdout: Metrics;
  curve: { date: string; value: number }[]; // 100 at the start of the build period
};

export type LabResults = {
  start: string;
  end: string;
  split: string;
  notional: number;
  slippagePct: number;
  etfCount: number;
  benchmark: { build: Metrics; holdout: Metrics; curve: { date: string; value: number }[] };
  strategies: LabStrategyResult[];
};

const MEANREV_SYMBOLS = ["SPY", "QQQ", "IWM", "DIA"];

function normalized(curve: CurvePoint[], start: string) {
  const pts = curve.filter((p) => p.date >= start);
  const base = pts[0]?.equity || 1;
  return sampleCurve(pts, 260).map((p) => ({ date: p.date, value: (p.equity / base) * 100 }));
}

export async function runLab(): Promise<number> {
  await ensureSchema();
  const db = requireDb();
  const settings = await loadSettings();
  const symbols = (await db.select({ symbol: schema.symbols.symbol }).from(schema.symbols).where(eq(schema.symbols.active, true))).map((r) => r.symbol);
  const bars = await loadHistory(db, symbols, "2016-01-01");
  const results = computeLab(bars, settings);
  const [row] = await db.insert(schema.labRuns).values({ results }).returning({ id: schema.labRuns.id });
  return row.id;
}

/** All lab calculations, without the database. */
export function computeLab(bars: Map<string, OHLCV[]>, settings: Settings): LabResults {
  const spy = bars.get("SPY");
  if (!spy || spy.length < 600) throw new Error("Not enough SPY history. Load history on the Backtest page first.");

  const calendar = spy.map((b) => b.date);
  // Every strategy needs a year of history before it can act, so measuring starts one year in.
  const start = calendar[252];
  const end = calendar[calendar.length - 1];
  const measure = (curve: CurvePoint[], trades: LabTrade[]) => ({
    build: windowMetrics(curve, trades, start, BUILD_END),
    holdout: windowMetrics(curve, trades, SPLIT_DATE, end),
  });

  const closes = new Map<string, Map<string, number>>();
  for (const [s, b] of bars) closes.set(s, new Map(b.map((x) => [x.date, x.close])));

  const benchCurve: CurvePoint[] = spy.map((b) => ({ date: b.date, equity: b.close, invested: b.close }));

  const etfs = UNIVERSE.filter((u) => u.kind === "etf").map((u) => u.symbol).filter((s) => bars.has(s));
  const rot = simulateRotation(bars, calendar, etfs, LAB_NOTIONAL);
  const mr = simulateMeanReversion(bars, calendar, MEANREV_SYMBOLS.filter((s) => bars.has(s)), LAB_NOTIONAL);

  const spySma = smaSeries(spy.map((b) => b.close), 200);
  const uptrend = new Set(spy.filter((b, k) => spySma[k] !== null && b.close > spySma[k]!).map((b) => b.date));
  const simCfg = { rules: settings, timeStopDays: settings.timeStopDays, slippagePct: LAB_SLIPPAGE_PCT, entryWindowDays: 2, signalFilter: (d: string) => uptrend.has(d) };
  const signals = [...bars].flatMap(([s, b]) => simulateSymbol(s, b, "fixed", simCfg).trades);
  const pf = runPortfolio(
    signals,
    { startEquity: LAB_NOTIONAL, riskPct: settings.riskPct, maxPositionPct: settings.maxPositionPct, maxPositions: settings.maxPositions, weeklyLossLimitPct: settings.weeklyLossLimitPct },
    calendar[0], end,
  );
  const pfCurve = markToMarket(pf.done, calendar, closes, LAB_NOTIONAL);
  const pfTrades: LabTrade[] = pf.done.map((t) => ({ symbol: t.symbol, entryDate: t.entryDate, exitDate: t.exitDate, ret: t.exit / t.entry - 1 }));

  const sims: Record<string, { curve: CurvePoint[]; trades: LabTrade[] }> = {
    rotation: rot,
    meanrev: mr,
    "pullback-filter": { curve: pfCurve, trades: pfTrades },
  };

  const results: LabResults = {
    start, end, split: SPLIT_DATE, notional: LAB_NOTIONAL, slippagePct: LAB_SLIPPAGE_PCT, etfCount: etfs.length,
    benchmark: { ...measure(benchCurve, []), curve: normalized(benchCurve, start) },
    strategies: STRATEGIES.map((s) => ({ id: s.id, version: s.version, ...measure(sims[s.id].curve, sims[s.id].trades), curve: normalized(sims[s.id].curve, start) })),
  };
  return results;
}
