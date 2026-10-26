import { type OHLCV, smaSeries } from "../indicators";
import type { CurvePoint, LabTrade } from "./metrics";

/**
 * Pre-registered strategies. The rules and numbers here were written down before any of them was tested.
 * Changing a rule means bumping its version, and the lab shows every version that has been looked at.
 */
export const SPLIT_DATE = "2023-01-01";
export const BUILD_END = "2022-12-31";
export const LAB_SLIPPAGE_PCT = 0.1;
export const LAB_NOTIONAL = 100_000;

export type StrategyDef = { id: string; version: string; name: string; summary: string; rules: string[] };

export const STRATEGIES: StrategyDef[] = [
  {
    id: "rotation",
    version: "v1",
    name: "Trend rotation across ETFs",
    summary: "Monthly. Hold the three strongest ETFs that are in an uptrend, otherwise cash.",
    rules: [
      "After the last close of each month, rank every ETF in the universe by the average of its 6-month and 12-month price change.",
      "Only ETFs closing above their 200-day average can be held.",
      "Hold the top 3, about a third of the account each. Empty slots stay in cash.",
      "Trade at the next open. Holdings still in the top 3 are kept, not rebalanced.",
      "0.1% cost on every buy and sell.",
    ],
  },
  {
    id: "meanrev",
    version: "v1",
    name: "Short-term dip buying in index ETFs",
    summary: "Buy SPY, QQQ, IWM or DIA after three down days in an uptrend, sell on the first strong close.",
    rules: [
      "Only SPY, QQQ, IWM and DIA, and only while the ETF closes above its 200-day average.",
      "Buy at the next open after three lower closes in a row.",
      "Sell at the next open after the first close above the previous day's high, or after 10 trading days.",
      "Up to four positions, a quarter of the account each. No stop loss.",
      "0.1% cost on every buy and sell.",
    ],
  },
  {
    id: "pullback-filter",
    version: "v1",
    name: "Pullback setup with a market filter",
    summary: "The original scanner and planner, but only when the S&P 500 itself is in an uptrend.",
    rules: [
      "Exactly the live pullback scanner, planner, fixed stop, 2R target and 10-day time stop.",
      "New setups count only if SPY closed above its 200-day average that day.",
      "Your account rules: 1% risk per trade, at most 5 positions, 20% per position, 4% weekly loss limit.",
      "0.1% cost on every buy and sell.",
    ],
  },
];

type Series = { bars: OHLCV[]; idx: Map<string, number>; sma200: (number | null)[] };

function prep(bars: Map<string, OHLCV[]>, symbols: string[]): Map<string, Series> {
  const out = new Map<string, Series>();
  for (const s of symbols) {
    const b = bars.get(s);
    if (!b || b.length === 0) continue;
    out.set(s, { bars: b, idx: new Map(b.map((x, k) => [x.date, k])), sma200: smaSeries(b.map((x) => x.close), 200) });
  }
  return out;
}

type Pos = { shares: number; entry: number; entryDate: string; entryT: number };

function valueAt(pos: Map<string, Pos>, last: Map<string, number>): number {
  let v = 0;
  for (const [s, p] of pos) v += p.shares * (last.get(s) ?? p.entry);
  return v;
}

export function simulateRotation(
  bars: Map<string, OHLCV[]>, calendar: string[], symbols: string[], startEquity: number, top = 3, slippagePct = LAB_SLIPPAGE_PCT,
): { curve: CurvePoint[]; trades: LabTrade[] } {
  const S = prep(bars, symbols);
  const slip = slippagePct / 100;
  let cash = startEquity;
  const pos = new Map<string, Pos>();
  const last = new Map<string, number>();
  let sells: string[] = [];
  let buys: string[] = [];
  const curve: CurvePoint[] = [];
  const trades: LabTrade[] = [];

  for (let t = 0; t < calendar.length; t++) {
    const d = calendar[t];
    const keepSells: string[] = [];
    for (const s of sells) {
      const se = S.get(s)!;
      const k = se.idx.get(d);
      const p = pos.get(s);
      if (!p) continue;
      if (k === undefined) { keepSells.push(s); continue; }
      const px = se.bars[k].open * (1 - slip);
      cash += p.shares * px;
      trades.push({ symbol: s, entryDate: p.entryDate, exitDate: d, ret: px / p.entry - 1 });
      pos.delete(s);
    }
    sells = keepSells;
    const keepBuys: string[] = [];
    for (const s of buys) {
      const se = S.get(s)!;
      const k = se.idx.get(d);
      if (k === undefined) { keepBuys.push(s); continue; }
      const px = se.bars[k].open * (1 + slip);
      const equity = cash + valueAt(pos, last);
      const shares = Math.floor(Math.min(cash, equity / top) / px);
      if (shares > 0) { cash -= shares * px; pos.set(s, { shares, entry: px, entryDate: d, entryT: t }); }
    }
    buys = keepBuys;

    for (const [s, se] of S) { const k = se.idx.get(d); if (k !== undefined) last.set(s, se.bars[k].close); }
    const invested = valueAt(pos, last);
    curve.push({ date: d, equity: cash + invested, invested });

    const monthEnd = t < calendar.length - 1 && calendar[t + 1].slice(0, 7) !== d.slice(0, 7);
    if (!monthEnd) continue;
    const ranked: { s: string; score: number }[] = [];
    for (const [s, se] of S) {
      const k = se.idx.get(d);
      if (k === undefined || k < 252) continue;
      const c = se.bars[k].close;
      const sma = se.sma200[k];
      if (sma === null || c <= sma) continue;
      ranked.push({ s, score: (c / se.bars[k - 126].close - 1 + (c / se.bars[k - 252].close - 1)) / 2 });
    }
    ranked.sort((a, b) => b.score - a.score);
    const chosen = new Set(ranked.slice(0, top).map((r) => r.s));
    sells = [...pos.keys()].filter((s) => !chosen.has(s));
    buys = [...chosen].filter((s) => !pos.has(s));
  }
  return { curve, trades };
}

export function simulateMeanReversion(
  bars: Map<string, OHLCV[]>, calendar: string[], symbols: string[], startEquity: number, slippagePct = LAB_SLIPPAGE_PCT,
): { curve: CurvePoint[]; trades: LabTrade[] } {
  const S = prep(bars, symbols);
  const slip = slippagePct / 100;
  const maxPos = 4;
  let cash = startEquity;
  const pos = new Map<string, Pos>();
  const last = new Map<string, number>();
  const pendingBuy = new Set<string>();
  const pendingSell = new Set<string>();
  const curve: CurvePoint[] = [];
  const trades: LabTrade[] = [];

  for (let t = 0; t < calendar.length; t++) {
    const d = calendar[t];
    for (const s of [...pendingSell]) {
      const se = S.get(s)!;
      const k = se.idx.get(d);
      const p = pos.get(s);
      if (!p) { pendingSell.delete(s); continue; }
      if (k === undefined) continue;
      const px = se.bars[k].open * (1 - slip);
      cash += p.shares * px;
      trades.push({ symbol: s, entryDate: p.entryDate, exitDate: d, ret: px / p.entry - 1 });
      pos.delete(s);
      pendingSell.delete(s);
    }
    for (const s of [...pendingBuy]) {
      const se = S.get(s)!;
      const k = se.idx.get(d);
      if (k === undefined) continue;
      const px = se.bars[k].open * (1 + slip);
      const equity = cash + valueAt(pos, last);
      const shares = Math.floor(Math.min(cash, equity / maxPos) / px);
      if (shares > 0) { cash -= shares * px; pos.set(s, { shares, entry: px, entryDate: d, entryT: t }); }
      pendingBuy.delete(s);
    }

    for (const [s, se] of S) { const k = se.idx.get(d); if (k !== undefined) last.set(s, se.bars[k].close); }
    const invested = valueAt(pos, last);
    curve.push({ date: d, equity: cash + invested, invested });

    for (const [s, se] of S) {
      const k = se.idx.get(d);
      if (k === undefined) continue;
      const b = se.bars;
      const p = pos.get(s);
      if (p) {
        if (!pendingSell.has(s) && ((k >= 1 && b[k].close > b[k - 1].high) || t - p.entryT + 1 >= 10)) pendingSell.add(s);
      } else if (!pendingBuy.has(s) && pos.size + pendingBuy.size < maxPos && k >= 3) {
        const sma = se.sma200[k];
        if (sma !== null && b[k].close > sma && b[k].close < b[k - 1].close && b[k - 1].close < b[k - 2].close && b[k - 2].close < b[k - 3].close) {
          pendingBuy.add(s);
        }
      }
    }
  }
  return { curve, trades };
}
