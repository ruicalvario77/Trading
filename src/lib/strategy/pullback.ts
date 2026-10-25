import { type OHLCV, smaAt, ema, atrAt, avgVolumeAt } from "../indicators";

/**
 * Pullback in an uptrend, evaluated on the last bar of `b`.
 *
 * Conditions:
 *  1. close above the 200-day SMA
 *  2. 50-day SMA above the 200-day SMA
 *  3. within the last `touchLookback` bars the low touched or dipped below the 20-day EMA
 *  4. today's close above yesterday's close (the pullback is turning)
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

export function evaluatePullback(b: OHLCV[], touchLookback = 3): SetupResult {
  const i = b.length - 1;
  if (b.length < MIN_HISTORY) return { ok: false, reason: `only ${b.length} bars, need ${MIN_HISTORY}` };
  const closes = b.map((x) => x.close);
  const sma200 = smaAt(closes, i, 200)!;
  const sma50 = smaAt(closes, i, 50)!;
  const ema20s = ema(closes, 20);
  const atr14 = atrAt(b, i, 14)!;
  const avgVolume20 = avgVolumeAt(b, i, 20)!;
  const close = closes[i];

  if (!(close > sma200)) return { ok: false, reason: "close below 200-day SMA" };
  if (!(sma50 > sma200)) return { ok: false, reason: "50-day SMA below 200-day SMA" };

  let touched = false;
  for (let k = i - touchLookback + 1; k <= i; k++) {
    const e = ema20s[k];
    if (e !== null && b[k].low <= e) touched = true;
  }
  if (!touched) return { ok: false, reason: `no touch of 20-day EMA in last ${touchLookback} bars` };
  if (!(close > closes[i - 1])) return { ok: false, reason: "close not above yesterday's close" };

  let pullbackLow = Infinity;
  for (let k = i - 4; k <= i; k++) pullbackLow = Math.min(pullbackLow, b[k].low);

  // Trend strength: how far price sits above the long average, scaled by volatility. Higher ranks first.
  const score = (close - sma200) / atr14;

  return {
    ok: true,
    close,
    todayHigh: b[i].high,
    pullbackLow,
    atr14,
    avgVolume20,
    sma50,
    sma200,
    ema20: ema20s[i]!,
    score,
  };
}
