import { type OHLCV, ema, smaSeries, atrSeries, rsiSeries, rollingExtreme, round2 } from "../indicators";

/**
 * Swing setups for the whole market, long only. Each one looks at a symbol's daily bars up to a close and
 * either returns a trade plan for the next session or nothing. Rules and numbers are fixed per version;
 * changing a rule means a new version, tested from scratch.
 */
export type Plan = {
  entryType: "stop" | "open"; // buy on a rise through `entry`, or buy at the next open
  entry: number; // trigger price, or the reference close for open entries
  stop: number;
  targetR: number | null; // sell at entry + targetR x risk; null means no target
  timeStopDays: number; // sell at the next open after this many days held
  exitOnStrongClose: boolean; // sell at the next open after a close above the prior day's high
  score: number; // higher ranks first
  why: string;
};

export type SymbolData = {
  b: OHLCV[];
  sma50: (number | null)[];
  sma200: (number | null)[];
  ema20: (number | null)[];
  atr14: (number | null)[];
  vol50: (number | null)[];
  rsi2: (number | null)[];
  hi20: (number | null)[];
  lo20: (number | null)[];
  hi50: (number | null)[];
  hi252: (number | null)[];
  lo5: (number | null)[];
};

export type MarketCtx = { spyClose: Map<string, number>; spyDates: string[]; spyIdx: Map<string, number> };

export type Setup = {
  id: string;
  version: string;
  name: string;
  summary: string;
  rules: string[];
  detect: (d: SymbolData, i: number, ctx: MarketCtx) => Plan | null;
};

export const MIN_BARS = 253;

export function prepare(b: OHLCV[]): SymbolData {
  const closes = b.map((x) => x.close);
  const highs = b.map((x) => x.high);
  const lows = b.map((x) => x.low);
  return {
    b,
    sma50: smaSeries(closes, 50),
    sma200: smaSeries(closes, 200),
    ema20: ema(closes, 20),
    atr14: atrSeries(b, 14),
    vol50: smaSeries(b.map((x) => x.volume), 50),
    rsi2: rsiSeries(closes, 2),
    hi20: rollingExtreme(highs, 20, "max"),
    lo20: rollingExtreme(lows, 20, "min"),
    hi50: rollingExtreme(highs, 50, "max"),
    hi252: rollingExtreme(highs, 252, "max"),
    lo5: rollingExtreme(lows, 5, "min"),
  };
}

export function marketCtx(spy: OHLCV[]): MarketCtx {
  return { spyClose: new Map(spy.map((b) => [b.date, b.close])), spyDates: spy.map((b) => b.date), spyIdx: new Map(spy.map((b, k) => [b.date, k])) };
}

const buf = (px: number) => Math.max(0.05, round2(px * 0.002));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const n = (x: number | null | undefined): x is number => x !== null && x !== undefined && Number.isFinite(x);

function spyReturn(ctx: MarketCtx, date: string, days: number): number | null {
  const k = ctx.spyIdx.get(date);
  if (k === undefined || k < days) return null;
  return ctx.spyClose.get(date)! / ctx.spyClose.get(ctx.spyDates[k - days])! - 1;
}

export const SETUPS: Setup[] = [
  {
    id: "pullback", version: "v1", name: "Pullback in an uptrend",
    summary: "The original setup: an uptrend dips to its 20-day average and turns up.",
    rules: [
      "Close above the 200-day average, 50-day above the 200-day.",
      "The low touched the 20-day average in the last 3 days, and today closed higher than yesterday.",
      "Buy on a rise above today's high. Stop under the 5-day low. Target 2R. Out after 10 days.",
    ],
    detect: (d, i) => {
      const { b } = d;
      const [s50, s200, a] = [d.sma50[i], d.sma200[i], d.atr14[i]];
      if (!n(s50) || !n(s200) || !n(a) || !(b[i].close > s200 && s50 > s200 && b[i].close > b[i - 1].close)) return null;
      let touched = false;
      for (let k = i - 2; k <= i; k++) { const e = d.ema20[k]; if (n(e) && b[k].low <= e) touched = true; }
      if (!touched) return null;
      const entry = round2(b[i].high + buf(b[i].close));
      const stop = round2(d.lo5[i]! - Math.max(0.05, a * 0.25));
      return { entryType: "stop", entry, stop, targetR: 2, timeStopDays: 10, exitOnStrongClose: false, score: (b[i].close - s200) / a,
        why: `Uptrend ${pct(b[i].close / s200 - 1)} above the 200-day average, dipped to the 20-day average and turned up.` };
    },
  },
  {
    id: "breakout", version: "v1", name: "Breakout from a tight range",
    summary: "A stock that went quiet for a month breaks to a 50-day high on heavy volume.",
    rules: [
      "Close above the 200-day average and above the highest high of the previous 50 days.",
      "The previous 20 days traded in a range under 12% of the price.",
      "Volume at least 1.5 times its 50-day average.",
      "Buy at the next open. Stop 2 ATR below the close. Target 3R. Out after 20 days.",
    ],
    detect: (d, i) => {
      const { b } = d;
      const [s200, a, v50, prevHi50, hi20p, lo20p] = [d.sma200[i], d.atr14[i], d.vol50[i - 1], d.hi50[i - 1], d.hi20[i - 1], d.lo20[i - 1]];
      if (!n(s200) || !n(a) || !n(v50) || !n(prevHi50) || !n(hi20p) || !n(lo20p)) return null;
      const range = (hi20p - lo20p) / b[i].close;
      const volRatio = b[i].volume / v50;
      if (!(b[i].close > s200 && b[i].close > prevHi50 && range < 0.12 && volRatio >= 1.5)) return null;
      return { entryType: "open", entry: b[i].close, stop: round2(b[i].close - 2 * a), targetR: 3, timeStopDays: 20, exitOnStrongClose: false, score: volRatio,
        why: `Broke above its 50-day high after a ${pct(range)} range, on ${volRatio.toFixed(1)} times normal volume.` };
    },
  },
  {
    id: "rs-pullback", version: "v1", name: "Pullback in a market leader",
    summary: "A stock beating the S&P 500 by 15% or more over six months dips and turns up.",
    rules: [
      "Six-month return at least 15 points above SPY's.",
      "Close above the 50-day average, 50-day above the 200-day.",
      "The low touched the 20-day average in the last 3 days, and today closed higher than yesterday.",
      "Buy on a rise above today's high. Stop under the 5-day low. Target 2R. Out after 10 days.",
    ],
    detect: (d, i, ctx) => {
      const { b } = d;
      const [s50, s200, a] = [d.sma50[i], d.sma200[i], d.atr14[i]];
      if (!n(s50) || !n(s200) || !n(a) || i < 126) return null;
      const spy = spyReturn(ctx, b[i].date, 126);
      if (spy === null) return null;
      const rs = b[i].close / b[i - 126].close - 1 - spy;
      if (!(rs >= 0.15 && b[i].close > s50 && s50 > s200 && b[i].close > b[i - 1].close)) return null;
      let touched = false;
      for (let k = i - 2; k <= i; k++) { const e = d.ema20[k]; if (n(e) && b[k].low <= e) touched = true; }
      if (!touched) return null;
      return { entryType: "stop", entry: round2(b[i].high + buf(b[i].close)), stop: round2(d.lo5[i]! - Math.max(0.05, a * 0.25)), targetR: 2, timeStopDays: 10, exitOnStrongClose: false, score: rs,
        why: `Beat SPY by ${pct(rs)} over six months, dipped to its 20-day average and turned up.` };
    },
  },
  {
    id: "oversold", version: "v1", name: "Oversold bounce in an uptrend",
    summary: "A sharp two-day drop in a stock that is still above its 200-day average.",
    rules: [
      "Close above the 200-day average.",
      "2-day RSI below 5, meaning two days of heavy selling.",
      "Buy at the next open. Stop 3 ATR below the close.",
      "Sell at the next open after the first close above the previous day's high, or after 7 days.",
    ],
    detect: (d, i) => {
      const { b } = d;
      const [s200, a, r] = [d.sma200[i], d.atr14[i], d.rsi2[i]];
      if (!n(s200) || !n(a) || !n(r) || !(b[i].close > s200 && r < 5)) return null;
      return { entryType: "open", entry: b[i].close, stop: round2(b[i].close - 3 * a), targetR: null, timeStopDays: 7, exitOnStrongClose: true, score: 5 - r,
        why: `Two-day RSI ${r.toFixed(1)} while still above the 200-day average.` };
    },
  },
  {
    id: "gap", version: "v1", name: "Gap up that holds",
    summary: "A 4% gap up on double volume that closes near the day's high.",
    rules: [
      "Opened at least 4% above yesterday's close, on at least twice the 50-day average volume.",
      "Closed in the top quarter of the day's range, above the 50-day average.",
      "Buy on a rise above today's high. Stop under today's low. Target 2R. Out after 10 days.",
    ],
    detect: (d, i) => {
      const { b } = d;
      const [s50, v50] = [d.sma50[i], d.vol50[i - 1]];
      if (!n(s50) || !n(v50)) return null;
      const gap = b[i].open / b[i - 1].close - 1;
      const rng = b[i].high - b[i].low;
      if (!(gap >= 0.04 && b[i].volume >= 2 * v50 && rng > 0 && b[i].close >= b[i].low + 0.75 * rng && b[i].close > s50)) return null;
      return { entryType: "stop", entry: round2(b[i].high + buf(b[i].close)), stop: round2(b[i].low - buf(b[i].close)), targetR: 2, timeStopDays: 10, exitOnStrongClose: false, score: gap,
        why: `Gapped up ${pct(gap)} on ${(b[i].volume / v50).toFixed(1)} times normal volume and held near the high.` };
    },
  },
  {
    id: "nr7", version: "v1", name: "Quiet day in an uptrend",
    summary: "The narrowest day of the last seven, in a stock that is trending up.",
    rules: [
      "Today's high-to-low range is the smallest of the last 7 days.",
      "Close above the 50-day average, 50-day above the 200-day.",
      "Buy on a rise above today's high. Stop under today's low. Target 2R. Out after 5 days.",
    ],
    detect: (d, i) => {
      const { b } = d;
      const [s50, s200, a] = [d.sma50[i], d.sma200[i], d.atr14[i]];
      if (!n(s50) || !n(s200) || !n(a) || !(b[i].close > s50 && s50 > s200)) return null;
      const r = b[i].high - b[i].low;
      for (let k = i - 6; k < i; k++) if (b[k].high - b[k].low <= r) return null;
      return { entryType: "stop", entry: round2(b[i].high + buf(b[i].close)), stop: round2(b[i].low - buf(b[i].close)), targetR: 2, timeStopDays: 5, exitOnStrongClose: false, score: (b[i].close - s200) / a,
        why: `Narrowest range in 7 days while trending ${pct(b[i].close / s200 - 1)} above the 200-day average.` };
    },
  },
  {
    id: "new-high", version: "v1", name: "Near a 52-week high",
    summary: "Momentum: a stock within 2% of its one-year high with a rising 50-day average.",
    rules: [
      "Close within 2% of the highest high of the last 252 days, and higher than yesterday.",
      "Close above the 50-day average, and the 50-day is higher than 20 days ago.",
      "Buy at the next open. Stop 2.5 ATR below the close. Target 3R. Out after 30 days.",
    ],
    detect: (d, i) => {
      const { b } = d;
      const [s50, s50p, a, h] = [d.sma50[i], d.sma50[i - 20], d.atr14[i], d.hi252[i]];
      if (!n(s50) || !n(s50p) || !n(a) || !n(h) || i < 126) return null;
      if (!(b[i].close >= 0.98 * h && b[i].close > s50 && s50 > s50p && b[i].close > b[i - 1].close)) return null;
      const r6 = b[i].close / b[i - 126].close - 1;
      return { entryType: "open", entry: b[i].close, stop: round2(b[i].close - 2.5 * a), targetR: 3, timeStopDays: 30, exitOnStrongClose: false, score: r6,
        why: `Within ${pct(1 - b[i].close / h)} of its 52-week high, up ${pct(r6)} in six months.` };
    },
  },
  {
    id: "failed-breakdown", version: "v1", name: "Failed breakdown",
    summary: "Price dips under its 20-day low, then closes back above it: the sellers ran out.",
    rules: [
      "Today's low went below the lowest low of the previous 20 days, but the close finished back above that level.",
      "Close above the 200-day average.",
      "Buy on a rise above today's high. Stop under today's low. Target 2R. Out after 10 days.",
    ],
    detect: (d, i) => {
      const { b } = d;
      const [s200, a, lo] = [d.sma200[i], d.atr14[i], d.lo20[i - 1]];
      if (!n(s200) || !n(a) || !n(lo) || !(b[i].low < lo && b[i].close > lo && b[i].close > s200)) return null;
      return { entryType: "stop", entry: round2(b[i].high + buf(b[i].close)), stop: round2(b[i].low - buf(b[i].close)), targetR: 2, timeStopDays: 10, exitOnStrongClose: false, score: (b[i].close - lo) / a,
        why: `Undercut its 20-day low of $${lo.toFixed(2)} and closed back above it.` };
    },
  },
];

export function setupById(id: string): Setup | undefined {
  return SETUPS.find((s) => s.id === id);
}
