import { windowMetrics, sampleCurve, type Metrics, type CurvePoint } from "../lab/metrics";
import { type Market, isMonthEnd } from "./market";
import { CONFIGS, BASELINE_ID, type ConfigDef } from "./families";
import { simulateWeights, type SimResult } from "./sim";

/** Trailing window the loop judges rule sets on: about three years of trading days. */
export const LOOKBACK_DAYS = 756;
/** Inverse of the standard normal CDF (Acklam's approximation, accurate to about 1e-9). */
export function normInv(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - lo) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * How far the best of `n` rule sets can beat the index on risk-adjusted return by luck alone, over `years`
 * of data. It is the expected maximum of n zero-skill results (Bailey and Lopez de Prado), scaled by the
 * standard error of an annual risk-adjusted return, about 1/sqrt(years). A challenger must clear this bar.
 * Treating the rule sets as independent makes the bar stricter than it strictly needs to be, which is the
 * safe side to err on with real money at the end.
 */
export function requiredMargin(n: number, years = LOOKBACK_DAYS / 252): number {
  if (n <= 1) return 0;
  const g = 0.5772156649; // Euler-Mascheroni constant
  const expectedMax = (1 - g) * normInv(1 - 1 / n) + g * normInv(1 - 1 / (n * Math.E));
  return expectedMax / Math.sqrt(years);
}
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
 * takes over only if it beats the index by more than luck could explain (requiredMargin), and replaces a
 * sitting champion only if it beats that one by the same margin, so the loop does not chase noise.
 */
export function selectChampion(runs: ConfigRun[], t: number, current: string | null): Selection {
  const MARGIN = requiredMargin(runs.length);
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
    return { id: best.id, reason: `Beat the index on risk-adjusted return over the last three years by ${(best.sharpe - base).toFixed(2)}, more than the ${MARGIN.toFixed(2)} luck could explain.`, scores };
  }
  return {
    id: BASELINE_ID,
    reason: `No rule set beat the index by more than luck could explain (${MARGIN.toFixed(2)} on risk-adjusted return when choosing from ${runs.length}), so the loop holds the index.`,
    scores,
  };
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
