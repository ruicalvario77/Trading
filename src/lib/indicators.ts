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
