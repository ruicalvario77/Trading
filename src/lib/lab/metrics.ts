export type CurvePoint = { date: string; equity: number; invested: number };
export type LabTrade = { symbol: string; entryDate: string; exitDate: string; ret: number };

export type Metrics = {
  from: string;
  to: string;
  years: number;
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  volPct: number;
  exposurePct: number;
  trades: number;
  winRate: number | null;
  avgTradePct: number | null;
};

/** Performance over [from, to] of a daily curve, measured from the first point on or after `from`. */
export function windowMetrics(curve: CurvePoint[], trades: LabTrade[], from: string, to: string): Metrics {
  const pts = curve.filter((p) => p.date >= from && p.date <= to);
  if (pts.length < 2) {
    return { from, to, years: 0, totalReturnPct: 0, cagrPct: 0, maxDrawdownPct: 0, volPct: 0, exposurePct: 0, trades: 0, winRate: null, avgTradePct: null };
  }
  const a = pts[0];
  const b = pts[pts.length - 1];
  const years = (Date.parse(b.date) - Date.parse(a.date)) / (365.25 * 86_400_000);
  const g = b.equity / a.equity;
  let peak = a.equity;
  let dd = 0;
  const rets: number[] = [];
  let exposure = 0;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    peak = Math.max(peak, p.equity);
    dd = Math.max(dd, (peak - p.equity) / peak);
    if (k > 0) rets.push(p.equity / pts[k - 1].equity - 1);
    exposure += p.equity > 0 ? p.invested / p.equity : 0;
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(rets.length - 1, 1);
  const ts = trades.filter((t) => t.exitDate >= a.date && t.exitDate <= b.date);
  return {
    from: a.date,
    to: b.date,
    years,
    totalReturnPct: (g - 1) * 100,
    cagrPct: years > 0 && g > 0 ? (Math.pow(g, 1 / years) - 1) * 100 : 0,
    maxDrawdownPct: dd * 100,
    volPct: Math.sqrt(variance) * Math.sqrt(252) * 100,
    exposurePct: (exposure / pts.length) * 100,
    trades: ts.length,
    winRate: ts.length ? ts.filter((t) => t.ret > 0).length / ts.length : null,
    avgTradePct: ts.length ? (ts.reduce((s, t) => s + t.ret, 0) / ts.length) * 100 : null,
  };
}

export type HeldTrade = { symbol: string; entryDate: string; exitDate: string; entry: number; shares: number; pnl: number };

/** Daily account value from a list of sized trades, valuing open positions at each day's close. */
export function markToMarket(
  trades: HeldTrade[],
  calendar: string[],
  closes: Map<string, Map<string, number>>,
  startEquity: number,
): CurvePoint[] {
  const sorted = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  const open: (HeldTrade & { last: number })[] = [];
  let next = 0;
  let realized = 0;
  const out: CurvePoint[] = [];
  for (const d of calendar) {
    while (next < sorted.length && sorted[next].entryDate <= d) {
      open.push({ ...sorted[next], last: sorted[next].entry });
      next++;
    }
    let invested = 0;
    let unrealized = 0;
    for (let k = open.length - 1; k >= 0; k--) {
      const t = open[k];
      if (t.exitDate <= d) {
        realized += t.pnl;
        open.splice(k, 1);
        continue;
      }
      const c = closes.get(t.symbol)?.get(d);
      if (c !== undefined) t.last = c;
      invested += t.shares * t.last;
      unrealized += t.shares * (t.last - t.entry);
    }
    out.push({ date: d, equity: startEquity + realized + unrealized, invested });
  }
  return out;
}

/** Keeps at most `max` points, always including the first and last. */
export function sampleCurve<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, k) => points[Math.round(k * step)]);
}
