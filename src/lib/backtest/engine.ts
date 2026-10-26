import { type OHLCV, round2 } from "../indicators";
import { computeIndicators, pullbackAt, MIN_HISTORY } from "../strategy/pullback";
import { planTrade, type PlanRules } from "../planner";
import { entryLimitFor, weekStartUtc } from "../trades";

export const VARIANTS = ["fixed", "breakeven", "trail"] as const;
export type Variant = (typeof VARIANTS)[number];

export const VARIANT_LABEL: Record<Variant, string> = {
  fixed: "Fixed stop, 2R target, 10-day time stop",
  breakeven: "Stop to breakeven at +1R, 2R target, 10-day time stop",
  trail: "No target. Breakeven at +1R, then trail under the 5-day low",
};

export type ExitReason = "stop" | "breakeven" | "trail" | "target" | "time" | "end";

export type SimTrade = {
  symbol: string;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  entry: number; // fill price including slippage
  exit: number; // fill price including slippage
  riskPerShare: number;
  r: number;
  exitReason: ExitReason;
  score: number;
  daysHeld: number;
};

export type SimConfig = { rules: PlanRules; timeStopDays: number; slippagePct: number; entryWindowDays: number };
export type Funnel = { signals: number; rejected: Record<string, number>; unfilled: number; entered: number };

export function rejectKey(reason: string): string {
  if (reason.startsWith("price") && reason.includes("above")) return "price above maximum";
  if (reason.startsWith("price") && reason.includes("below")) return "price below minimum";
  if (reason.includes("volume")) return "volume too low";
  if (reason.includes("wider")) return "stop wider than 8%";
  if (reason.includes("tighter")) return "stop tighter than 1%";
  return "other";
}

/**
 * Replays one symbol's history day by day with the live scanner and planner. Decisions use only data up to
 * that day's close. Orders act from the next bar: a buy stop-limit for `entryWindowDays`, then the stop and
 * target. When a bar touches both stop and target, the stop is assumed to come first.
 */
export function simulateSymbol(symbol: string, b: OHLCV[], variant: Variant, cfg: SimConfig): { trades: SimTrade[]; funnel: Funnel } {
  const ind = computeIndicators(b);
  const trades: SimTrade[] = [];
  const funnel: Funnel = { signals: 0, rejected: {}, unfilled: 0, entered: 0 };
  const slip = cfg.slippagePct / 100;
  let i = MIN_HISTORY - 1;

  while (i < b.length - 1) {
    const s = pullbackAt(b, ind, i);
    if (!s.ok) { i++; continue; }
    funnel.signals++;
    // Sizing depends on the portfolio, so plan with an unlimited account here and size later.
    const plan = planTrade(s, { ...cfg.rules, accountUsd: 1e12, maxPositionPct: 100 });
    if (!plan.tradeable) {
      for (const r of plan.reasons) { const k = rejectKey(r); funnel.rejected[k] = (funnel.rejected[k] ?? 0) + 1; }
      i++;
      continue;
    }

    const limit = entryLimitFor(plan.entry);
    let f = -1;
    let fillPx = 0;
    for (let j = i + 1; j <= Math.min(i + cfg.entryWindowDays, b.length - 1); j++) {
      const d = b[j];
      if (d.open >= plan.entry) {
        if (d.open <= limit) { f = j; fillPx = d.open; }
        else if (d.low <= limit) { f = j; fillPx = limit; }
      } else if (d.high >= plan.entry) { f = j; fillPx = plan.entry; }
      if (f >= 0) break;
    }
    if (f < 0) { funnel.unfilled++; i++; continue; }
    funnel.entered++;

    const entry = fillPx * (1 + slip);
    const risk = entry - plan.stop;
    if (risk <= 0) { i = f; continue; }
    const oneR = plan.entry - plan.stop;
    let stop = plan.stop;
    const target: number | null = variant === "trail" ? null : plan.target;
    let moved = false;
    let timeExit = false;
    let x = b.length - 1;
    let exitPx = b[x].close;
    let reason: ExitReason = "end";

    for (let d = f; d < b.length; d++) {
      const bar = b[d];
      const stopReason: ExitReason = !moved ? "stop" : variant === "trail" ? "trail" : "breakeven";
      if (d > f) {
        if (timeExit) { exitPx = bar.open; x = d; reason = "time"; break; }
        if (bar.open <= stop) { exitPx = bar.open; x = d; reason = stopReason; break; }
        if (target !== null && bar.open >= target) { exitPx = bar.open; x = d; reason = "target"; break; }
      }
      if (bar.low <= stop) { exitPx = stop; x = d; reason = stopReason; break; }
      if (target !== null && bar.high >= target) { exitPx = target; x = d; reason = "target"; break; }

      // After the close: move the stop for the next session.
      if (variant !== "fixed" && !moved && bar.close >= plan.entry + oneR) { stop = Math.max(stop, plan.entry); moved = true; }
      if (variant === "trail" && moved) {
        let lo = Infinity;
        for (let k = Math.max(f, d - 4); k <= d; k++) lo = Math.min(lo, b[k].low);
        stop = Math.max(stop, round2(lo - 0.01));
      }
      // The trailing variant lets a working trade run; the time stop only removes trades that never got going.
      if (d - f + 1 >= cfg.timeStopDays && !(variant === "trail" && moved)) timeExit = true;
    }

    const exit = exitPx * (1 - slip);
    trades.push({
      symbol, signalDate: b[i].date, entryDate: b[f].date, exitDate: b[x].date, entry, exit,
      riskPerShare: risk, r: (exit - entry) / risk, exitReason: reason, score: s.score, daysHeld: x - f + 1,
    });
    i = x;
  }
  return { trades, funnel };
}

export type PortfolioConfig = {
  startEquity: number;
  riskPct: number;
  maxPositionPct: number;
  maxPositions: number;
  weeklyLossLimitPct: number;
};

export type TakenTrade = SimTrade & { shares: number; pnl: number };

export type PortfolioSummary = {
  startEquity: number;
  finalEquity: number;
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  taken: number;
  skipped: { tooSmall: number; maxPositions: number; weeklyLimit: number };
};

export type PortfolioResult = PortfolioSummary & {
  curve: { date: string; equity: number }[];
  perYear: { year: string; trades: number; pnl: number; returnPct: number; sumR: number }[];
  done: TakenTrade[];
};

const weekKey = (d: string) => weekStartUtc(new Date(`${d}T00:00:00Z`)).toISOString().slice(0, 10);

/**
 * Takes signals in date order (best score first on the same day) under the live account rules: risk per
 * trade sized from current equity, position cap, no margin, max positions, weekly loss limit.
 * Equity is counted on closed trades only.
 */
export function runPortfolio(trades: SimTrade[], cfg: PortfolioConfig, firstDate: string, lastDate: string): PortfolioResult {
  const sorted = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate) || b.score - a.score);
  let equity = cfg.startEquity;
  const open: TakenTrade[] = [];
  const done: TakenTrade[] = [];
  const weekPnl = new Map<string, number>();
  const curve = [{ date: firstDate, equity }];
  const skipped = { tooSmall: 0, maxPositions: 0, weeklyLimit: 0 };

  const release = (before: string) => {
    open.sort((a, b) => a.exitDate.localeCompare(b.exitDate));
    while (open.length && open[0].exitDate < before) {
      const t = open.shift()!;
      equity += t.pnl;
      const wk = weekKey(t.exitDate);
      weekPnl.set(wk, (weekPnl.get(wk) ?? 0) + t.pnl);
      curve.push({ date: t.exitDate, equity });
      done.push(t);
    }
  };

  for (const t of sorted) {
    release(t.entryDate);
    if ((weekPnl.get(weekKey(t.entryDate)) ?? 0) <= -(equity * cfg.weeklyLossLimitPct) / 100) { skipped.weeklyLimit++; continue; }
    if (open.length >= cfg.maxPositions) { skipped.maxPositions++; continue; }
    const openValue = open.reduce((s, o) => s + o.shares * o.entry, 0);
    const shares = Math.min(
      Math.floor((equity * cfg.riskPct) / 100 / t.riskPerShare),
      Math.floor((equity * cfg.maxPositionPct) / 100 / t.entry),
      Math.floor((equity - openValue) / t.entry),
    );
    if (shares < 1) { skipped.tooSmall++; continue; }
    open.push({ ...t, shares, pnl: shares * (t.exit - t.entry) });
  }
  release("9999-12-31");

  let peak = cfg.startEquity;
  let maxDd = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    maxDd = Math.max(maxDd, (peak - p.equity) / peak);
  }
  const years = Math.max((Date.parse(lastDate) - Date.parse(firstDate)) / (365.25 * 86_400_000), 1 / 365);
  const growth = equity / cfg.startEquity;

  const byYear = new Map<string, TakenTrade[]>();
  for (const t of done) {
    const y = t.exitDate.slice(0, 4);
    (byYear.get(y) ?? byYear.set(y, []).get(y)!).push(t);
  }
  const equityBefore = (date: string) => {
    let e = cfg.startEquity;
    for (const p of curve) { if (p.date < date) e = p.equity; else break; }
    return e;
  };
  const perYear = [...byYear.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([year, ts]) => {
    const pnl = ts.reduce((s, t) => s + t.pnl, 0);
    return { year, trades: ts.length, pnl, returnPct: (pnl / equityBefore(`${year}-01-01`)) * 100, sumR: ts.reduce((s, t) => s + t.r, 0) };
  });

  return {
    startEquity: cfg.startEquity,
    finalEquity: equity,
    totalReturnPct: (growth - 1) * 100,
    cagrPct: growth > 0 ? (Math.pow(growth, 1 / years) - 1) * 100 : -100,
    maxDrawdownPct: maxDd * 100,
    taken: done.length,
    skipped,
    curve,
    perYear,
    done,
  };
}
