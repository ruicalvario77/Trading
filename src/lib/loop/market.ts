import { type OHLCV, smaSeries } from "../indicators";

export type Weights = Record<string, number>;
export type Series = { bars: OHLCV[]; idx: Map<string, number>; smaCache: Map<number, (number | null)[]> };
export type Market = { calendar: string[]; S: Map<string, Series> };

/** Aligns every symbol to SPY's trading calendar. */
export function buildMarket(bars: Map<string, OHLCV[]>, calendarSymbol = "SPY"): Market {
  const cal = bars.get(calendarSymbol);
  if (!cal || cal.length === 0) throw new Error(`No ${calendarSymbol} history`);
  const S = new Map<string, Series>();
  for (const [s, b] of bars) S.set(s, { bars: b, idx: new Map(b.map((x, k) => [x.date, k])), smaCache: new Map() });
  return { calendar: cal.map((b) => b.date), S };
}

export function smaOf(se: Series, n: number): (number | null)[] {
  let v = se.smaCache.get(n);
  if (!v) { v = smaSeries(se.bars.map((b) => b.close), n); se.smaCache.set(n, v); }
  return v;
}

/** Index of `symbol`'s bar on calendar day t, or undefined when it did not trade. */
export function barIndex(m: Market, symbol: string, t: number): number | undefined {
  return m.S.get(symbol)?.idx.get(m.calendar[t]);
}

/** True when calendar day t is the last trading day of its month. On the newest day, assumes the next weekday. */
export function isMonthEnd(calendar: string[], t: number): boolean {
  const d = calendar[t];
  if (t < calendar.length - 1) return calendar[t + 1].slice(0, 7) !== d.slice(0, 7);
  const next = new Date(`${d}T12:00:00Z`);
  do next.setUTCDate(next.getUTCDate() + 1); while (next.getUTCDay() === 0 || next.getUTCDay() === 6);
  return next.toISOString().slice(0, 7) !== d.slice(0, 7);
}

export function sameWeights(a: Weights, b: Weights): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > 1e-9) return false;
  return true;
}
