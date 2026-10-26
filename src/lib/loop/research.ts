import { windowMetrics, sampleCurve, type Metrics, type CurvePoint } from "../lab/metrics";
import { type Market, isMonthEnd } from "./market";
import { CONFIGS, BASELINE_ID, type ConfigDef } from "./families";
import { simulateWeights, type SimResult } from "./sim";

/** Trailing window the loop judges rule sets on: about three years of trading days. */
export const LOOKBACK_DAYS = 756;
/** A challenger must beat the index, and the current champion, by this much risk-adjusted return. */
export const MARGIN = 0.1;
/** Rough cost of switching the whole account from one rule set to another. */
export const SWITCH_COST = 0.002;

export type ConfigRun = { def: ConfigDef; sim: SimResult; s1: Float64Array; s2: Float64Array };

export function runAll(m: Market, startEquity: number, configs = CONFIGS): ConfigRun[] {
  return configs.map((def) => {
    const sim = simulateWeights(m, def.make(m), startEquity);
    const s1 = new Float64Array(sim.rets.length + 1);
    const s2 = new Float64Array(sim.rets.length + 1);
    for (let i = 0; i < sim.rets.length; i++) { s1[i + 1] = s1[i] + sim.rets[i]; s2[i + 1] = s2[i] + sim.rets[i] ** 2; }
    return { def, sim, s1, s2 };
  });
}

/** Annualised return per unit of volatility over days (a, b]. */
export function sharpe(r: ConfigRun, a: number, b: number): number {
  const n = b - a;
  if (n < 20) return 0;
  const mean = (r.s1[b + 1] - r.s1[a + 1]) / n;
  const variance = (r.s2[b + 1] - r.s2[a + 1]) / n - mean * mean;
  return variance > 1e-12 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : 0;
}

/** First day on which every rule set has a full judging window behind it. */
export function firstDecisionDay(): number {
  return 252 + LOOKBACK_DAYS;
}

export type Selection = { id: string; reason: string; scores: { id: string; sharpe: number }[] };

/**
 * Picks the champion at day t from data up to t only. The index (hold SPY) is the default. A challenger
 * takes over only if it beats the index by MARGIN, and replaces a sitting champion only if it beats that one
 * by MARGIN too, so the loop does not chase noise from month to month.
 */
export function selectChampion(runs: ConfigRun[], t: number, current: string | null): Selection {
  const a = t - LOOKBACK_DAYS;
  const scores = runs.map((r) => ({ id: r.def.id, sharpe: a >= 0 ? sharpe(r, a, t) : 0 })).sort((x, y) => y.sharpe - x.sharpe);
  const score = (id: string | null) => scores.find((s) => s.id === id)?.sharpe ?? -Infinity;
  const base = score(BASELINE_ID);
  const best = scores[0];
  if (a < 0) return { id: BASELINE_ID, reason: "Not enough history yet, so the loop holds the index.", scores };
  if (current && current !== BASELINE_ID && score(current) >= base + MARGIN && best.id !== current && best.sharpe < score(current) + MARGIN) {
    return { id: current, reason: "The current champion still beats the index, and no challenger beats it by a clear margin.", scores };
  }
  if (best.id !== BASELINE_ID && best.sharpe >= base + MARGIN) {
    return { id: best.id, reason: `Beat the index on risk-adjusted return over the last three years by ${(best.sharpe - base).toFixed(2)}.`, scores };
  }
  return { id: BASELINE_ID, reason: "No rule set beat the index by a clear margin over the last three years, so the loop holds the index.", scores };
}

export type MetaTest = {
  from: string;
  to: string;
  loop: Metrics;
  index: Metrics;
  switches: number;
  timeInIndexPct: number;
  history: { date: string; id: string }[];
  loopCurve: { date: string; value: number }[];
  indexCurve: { date: string; value: number }[];
};

/**
 * Would this loop have beaten the index? Replays it month by month: at each month end it picks a champion
 * from the past only, then earns that rule set's returns until the next month end.
 */
export function metaTest(runs: ConfigRun[], m: Market): MetaTest {
  const start = firstDecisionDay();
  const base = runs.find((r) => r.def.id === BASELINE_ID)!;
  const byId = new Map(runs.map((r) => [r.def.id, r]));
  let champ: string | null = null;
  let equity = 100;
  const curve: CurvePoint[] = [{ date: m.calendar[start], equity, invested: equity }];
  const history: { date: string; id: string }[] = [];
  let switches = 0;
  let inIndex = 0;
  for (let t = start; t < m.calendar.length - 1; t++) {
    if (t === start || isMonthEnd(m.calendar, t)) {
      const pick: string = selectChampion(runs, t, champ).id;
      if (pick !== champ) {
        if (champ !== null) { switches++; equity *= 1 - SWITCH_COST; }
        history.push({ date: m.calendar[t], id: pick });
        champ = pick;
      }
    }
    if (champ === BASELINE_ID) inIndex++;
    equity *= 1 + byId.get(champ!)!.sim.rets[t + 1];
    curve.push({ date: m.calendar[t + 1], equity, invested: equity });
  }
  const from = m.calendar[start];
  const to = m.calendar[m.calendar.length - 1];
  const norm = (c: CurvePoint[]) => {
    const pts = c.filter((p) => p.date >= from);
    const b0 = pts[0].equity;
    return sampleCurve(pts, 240).map((p) => ({ date: p.date, value: (p.equity / b0) * 100 }));
  };
  return {
    from, to,
    loop: windowMetrics(curve, [], from, to),
    index: windowMetrics(base.sim.curve, [], from, to),
    switches,
    timeInIndexPct: (inIndex / Math.max(curve.length - 1, 1)) * 100,
    history,
    loopCurve: norm(curve),
    indexCurve: norm(base.sim.curve),
  };
}

export type LeaderRow = { id: string; label: string; family: string; sharpe: number; cagrPct: number; maxDrawdownPct: number };

export function leaderboard(runs: ConfigRun[], m: Market, top = 12): LeaderRow[] {
  const t = m.calendar.length - 1;
  const from = m.calendar[Math.max(0, t - LOOKBACK_DAYS)];
  return runs
    .map((r) => ({ r, s: sharpe(r, t - LOOKBACK_DAYS, t) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, top)
    .map(({ r, s }) => {
      const w = windowMetrics(r.sim.curve, [], from, m.calendar[t]);
      return { id: r.def.id, label: r.def.label, family: r.def.family, sharpe: s, cagrPct: w.cagrPct, maxDrawdownPct: w.maxDrawdownPct };
    });
}
