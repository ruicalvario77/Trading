import { type OHLCV, ema, smaSeries, atrSeries } from "../indicators";

/**
 * Pullback in an uptrend.
 *
 * Conditions on a given bar:
 *  1. close above the 200-day SMA
 *  2. 50-day SMA above the 200-day SMA
 *  3. within the last `touchLookback` bars the low touched or dipped below the 20-day EMA
 *  4. close above the previous close (the pullback is turning)
 *
 * The live scanner and the backtester both call pullbackAt, so they share one definition.
 */
export const MIN_HISTORY = 210;

export type SetupResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      close: number;
      todayHigh: number;
      pullbackLow: number;
      atr14: number;
      avgVolume20: number;
      sma50: number;
      sma200: number;
      ema20: number;
      score: number;
    };

export type Indicators = {
  sma200: (number | null)[];
  sma50: (number | null)[];
  ema20: (number | null)[];
  atr14: (number | null)[];
  avgVol20: (number | null)[];
};

export function computeIndicators(b: OHLCV[]): Indicators {
  const closes = b.map((x) => x.close);
  return {
    sma200: smaSeries(closes, 200),
    sma50: smaSeries(closes, 50),
    ema20: ema(closes, 20),
    atr14: atrSeries(b, 14),
    avgVol20: smaSeries(b.map((x) => x.volume), 20),
  };
}

export function pullbackAt(b: OHLCV[], ind: Indicators, i: number, touchLookback = 3): SetupResult {
  if (i < MIN_HISTORY - 1) return { ok: false, reason: `only ${i + 1} bars, need ${MIN_HISTORY}` };
  const sma200 = ind.sma200[i]!;
  const sma50 = ind.sma50[i]!;
  const atr14 = ind.atr14[i]!;
  const avgVolume20 = ind.avgVol20[i]!;
  const close = b[i].close;

  if (!(close > sma200)) return { ok: false, reason: "close below 200-day SMA" };
  if (!(sma50 > sma200)) return { ok: false, reason: "50-day SMA below 200-day SMA" };

  let touched = false;
  for (let k = i - touchLookback + 1; k <= i; k++) {
    const e = ind.ema20[k];
    if (e !== null && b[k].low <= e) touched = true;
  }
  if (!touched) return { ok: false, reason: `no touch of 20-day EMA in last ${touchLookback} bars` };
  if (!(close > b[i - 1].close)) return { ok: false, reason: "close not above yesterday's close" };

  let pullbackLow = Infinity;
  for (let k = i - 4; k <= i; k++) pullbackLow = Math.min(pullbackLow, b[k].low);

  // Trend strength: how far price sits above the long average, scaled by volatility. Higher ranks first.
  const score = (close - sma200) / atr14;

  return { ok: true, close, todayHigh: b[i].high, pullbackLow, atr14, avgVolume20, sma50, sma200, ema20: ind.ema20[i]!, score };
}

/** Evaluates the last bar of `b`. */
export function evaluatePullback(b: OHLCV[], touchLookback = 3): SetupResult {
  if (b.length < MIN_HISTORY) return { ok: false, reason: `only ${b.length} bars, need ${MIN_HISTORY}` };
  return pullbackAt(b, computeIndicators(b), b.length - 1, touchLookback);
}

/** One plain-language sentence a beginner can check against the chart. */
export function explainPullback(s: Extract<SetupResult, { ok: true }>, entry: number, stop: number): string {
  const above = ((s.close / s.sma200 - 1) * 100).toFixed(1);
  return `Uptrend: closed ${above}% above its 200-day average, with the 50-day average above the 200-day. ` +
    `Pulled back to the 20-day average and closed higher today. Buy only if it trades up through $${entry.toFixed(2)}. ` +
    `The idea is wrong below $${stop.toFixed(2)}.`;
}
