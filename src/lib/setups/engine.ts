import type { OHLCV } from "../indicators";
import { entryLimitFor } from "../trades";
import { summarizeR, type RStats } from "../stats";
import { normInv } from "../loop/research";
import { MIN_BARS, prepare, type MarketCtx, type Plan, type Setup, type SymbolData } from "./library";

export const SLIPPAGE_PCT = 0.1;
export const ENTRY_WINDOW_DAYS = 2;

export type Limits = { minPrice: number; maxPrice: number };

/** Shared filters on every plan: price band and a stop between 1% and 10% below entry. */
export function planProblem(p: Plan, lim: Limits): string | null {
  if (p.entry < lim.minPrice) return "price below minimum";
  if (p.entry > lim.maxPrice) return "price above maximum";
  const pct = (p.entry - p.stop) / p.entry;
  if (!(pct > 0)) return "stop not below entry";
  if (pct < 0.01) return "stop tighter than 1%";
  if (pct > 0.1) return "stop wider than 10%";
  return null;
}

export type Outcome =
  | { status: "unfilled" }
  | { status: "open"; f: number; entry: number; stop: number }
  | { status: "closed"; f: number; x: number; entry: number; exit: number; r: number; reason: "stop" | "target" | "time" | "strong" | "end" };

/**
 * Plays one plan forward from the bar after signal day i. Used for backtests and for the nightly forward
 * record, so both follow identical rules. Fills and exits include slippage. When a day touches both stop and
 * target, the stop is assumed first. With closeAtEnd, a trade still open on the last bar is closed there.
 */
export function runPlan(b: OHLCV[], i: number, p: Plan, closeAtEnd: boolean, slipPct = SLIPPAGE_PCT): Outcome {
  const slip = slipPct / 100;
  let f = -1;
  let fill = 0;
  if (p.entryType === "open") {
    if (i + 1 < b.length && b[i + 1].open > p.stop) { f = i + 1; fill = b[f].open; }
    else if (i + 1 < b.length) return { status: "unfilled" };
  } else {
    const limit = entryLimitFor(p.entry);
    for (let j = i + 1; j <= Math.min(i + ENTRY_WINDOW_DAYS, b.length - 1); j++) {
      const d = b[j];
      if (d.open >= p.entry) {
        if (d.open <= limit) { f = j; fill = d.open; } else if (d.low <= limit) { f = j; fill = limit; }
      } else if (d.high >= p.entry) { f = j; fill = p.entry; }
      if (f >= 0) break;
    }
    if (f < 0) {
      return i + ENTRY_WINDOW_DAYS <= b.length - 1 || closeAtEnd ? { status: "unfilled" } : { status: "open", f: -1, entry: 0, stop: p.stop };
    }
  }
  if (f < 0) return closeAtEnd ? { status: "unfilled" } : { status: "open", f: -1, entry: 0, stop: p.stop };

  const entry = fill * (1 + slip);
  const risk = entry - p.stop;
  if (risk <= 0) return { status: "unfilled" };
  const target = p.targetR === null ? null : entry + p.targetR * risk;
  let pendingTime = false;
  let pendingStrong = false;
  for (let d = f; d < b.length; d++) {
    const bar = b[d];
    let exitPx: number | null = null;
    let reason: "stop" | "target" | "time" | "strong" | null = null;
    if (d > f) {
      if (pendingTime || pendingStrong) { exitPx = bar.open; reason = pendingStrong ? "strong" : "time"; }
      else if (bar.open <= p.stop) { exitPx = bar.open; reason = "stop"; }
      else if (target !== null && bar.open >= target) { exitPx = bar.open; reason = "target"; }
    }
    if (exitPx === null) {
      if (bar.low <= p.stop) { exitPx = p.stop; reason = "stop"; }
      else if (target !== null && bar.high >= target) { exitPx = target; reason = "target"; }
    }
    if (exitPx !== null && reason) {
      const exit = exitPx * (1 - slip);
      return { status: "closed", f, x: d, entry, exit, r: (exit - entry) / risk, reason };
    }
    if (p.exitOnStrongClose && d >= 1 && bar.close > b[d - 1].high) pendingStrong = true;
    if (d - f + 1 >= p.timeStopDays) pendingTime = true;
  }
  if (!closeAtEnd) return { status: "open", f, entry, stop: p.stop };
  const x = b.length - 1;
  const exit = b[x].close * (1 - slip);
  return { status: "closed", f, x, entry, exit, r: (exit - entry) / risk, reason: "end" };
}

export type SetupTrade = { symbol: string; signalDate: string; entryDate: string; exitDate: string; r: number; reason: string; score: number };

export type SetupFunnel = { signals: number; rejected: Record<string, number>; unfilled: number; entered: number };

/** All trades one setup would have taken on one symbol, one at a time. */
export function backtestSymbol(setup: Setup, symbol: string, d: SymbolData, ctx: MarketCtx, lim: Limits, from = MIN_BARS): { trades: SetupTrade[]; funnel: SetupFunnel } {
  const trades: SetupTrade[] = [];
  const funnel: SetupFunnel = { signals: 0, rejected: {}, unfilled: 0, entered: 0 };
  let i = Math.max(from, MIN_BARS);
  while (i < d.b.length - 1) {
    const p = setup.detect(d, i, ctx);
    if (!p) { i++; continue; }
    funnel.signals++;
    const problem = planProblem(p, lim);
    if (problem) { funnel.rejected[problem] = (funnel.rejected[problem] ?? 0) + 1; i++; continue; }
    const o = runPlan(d.b, i, p, true);
    if (o.status !== "closed") { funnel.unfilled++; i++; continue; }
    funnel.entered++;
    trades.push({ symbol, signalDate: d.b[i].date, entryDate: d.b[o.f].date, exitDate: d.b[o.x].date, r: o.r, reason: o.reason, score: p.score });
    i = o.x;
  }
  return { trades, funnel };
}

/**
 * Evidence that a setup's average R is above zero. Trades entered on the same day move together, so they are
 * averaged per day first, and the t-statistic is taken over days. That is stricter than counting every trade.
 */
export function dailyT(trades: { entryDate: string; r: number }[]): { t: number; days: number } {
  const byDay = new Map<string, number[]>();
  for (const x of trades) (byDay.get(x.entryDate) ?? byDay.set(x.entryDate, []).get(x.entryDate)!).push(x.r);
  const means = [...byDay.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  const k = means.length;
  if (k < 3) return { t: 0, days: k };
  const m = means.reduce((a, b) => a + b, 0) / k;
  const sd = Math.sqrt(means.reduce((a, b) => a + (b - m) ** 2, 0) / (k - 1));
  return { t: sd > 0 ? m / (sd / Math.sqrt(k)) : 0, days: k };
}

/** The t a setup needs when `n` setups are tested at once: a 5% chance of any false pass (Bonferroni). */
export function luckBarT(n: number): number {
  return normInv(1 - 0.05 / Math.max(n, 1));
}

export const MIN_EDGE_R = 0.05;

export type SetupVerdict = { pass: boolean; reasons: string[] };

export function judge(edge: RStats, t: number, earlier: RStats, later: RStats, nSetups: number): SetupVerdict {
  const bar = luckBarT(nSetups);
  const reasons: string[] = [];
  if (edge.trades < 100) reasons.push(`only ${edge.trades} trades, needs 100`);
  if (edge.expectancyR < MIN_EDGE_R) reasons.push(`average ${edge.expectancyR.toFixed(2)}R per trade, needs ${MIN_EDGE_R}R after costs`);
  if (t < bar) reasons.push(`evidence ${t.toFixed(2)}, needs ${bar.toFixed(2)} when testing ${nSetups} setups`);
  if (!(earlier.expectancyR > 0 && later.expectancyR > 0)) reasons.push("not positive in both halves of the period");
  return { pass: reasons.length === 0, reasons };
}

export function stats(trades: SetupTrade[]) {
  const sorted = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  return { edge: summarizeR(sorted.map((x) => x.r)), ...dailyT(sorted) };
}

export { prepare };
