export type OHLCV = { date: string; open: number; high: number; low: number; close: number; volume: number };

/** Simple moving average of the last `n` values ending at index `i` (inclusive). Returns null if not enough data. */
export function smaAt(values: number[], i: number, n: number): number | null {
  if (i + 1 < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += values[k];
  return s / n;
}

/** Full EMA series. Seeded with the SMA of the first `n` values; entries before that are null. */
export function ema(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let prev = smaAt(values, n - 1, n)!;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Average true range over the last `n` bars ending at index `i`. Wilder-free simple average, good enough for sizing. */
export function atrAt(b: OHLCV[], i: number, n: number): number | null {
  if (i < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const tr = Math.max(b[k].high - b[k].low, Math.abs(b[k].high - b[k - 1].close), Math.abs(b[k].low - b[k - 1].close));
    s += tr;
  }
  return s / n;
}

export function avgVolumeAt(b: OHLCV[], i: number, n: number): number | null {
  if (i + 1 < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += b[k].volume;
  return s / n;
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Rolling simple average for every index. Matches smaAt. */
export function smaSeries(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    s += values[i];
    if (i >= n) s -= values[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

/** Rolling average true range for every index. Matches atrAt. */
export function atrSeries(b: OHLCV[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(b.length).fill(null);
  const tr = (k: number) => Math.max(b[k].high - b[k].low, Math.abs(b[k].high - b[k - 1].close), Math.abs(b[k].low - b[k - 1].close));
  let s = 0;
  for (let i = 1; i < b.length; i++) {
    s += tr(i);
    if (i > n) s -= tr(i - n);
    if (i >= n) out[i] = s / n;
  }
  return out;
}

/** RSI with Wilder smoothing. Null until n+1 bars exist. */
export function rsiSeries(closes: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n;
  loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Highest (or lowest) value over the last n values ending at each index, inclusive. */
export function rollingExtreme(values: number[], n: number, kind: "max" | "min"): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const dq: number[] = [];
  const better = kind === "max" ? (a: number, b: number) => a >= b : (a: number, b: number) => a <= b;
  for (let i = 0; i < values.length; i++) {
    while (dq.length && better(values[i], values[dq[dq.length - 1]])) dq.pop();
    dq.push(i);
    if (dq[0] <= i - n) dq.shift();
    if (i >= n - 1) out[i] = values[dq[0]];
  }
  return out;
}
