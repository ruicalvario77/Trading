import { and, eq, gte } from "drizzle-orm";
import { requireDb, schema } from "../db";
import { ensureSchema } from "../db/migrate";
import { loadSettings } from "../settings";
import { DATA_FEED } from "../alpaca";
import { summarizeR, type RStats } from "../stats";
import type { OHLCV } from "../indicators";
import {
  VARIANTS, VARIANT_LABEL, simulateSymbol, runPortfolio,
  type Variant, type SimTrade, type Funnel, type PortfolioSummary, type PortfolioConfig,
} from "./engine";

export type VariantResult = {
  variant: Variant;
  label: string;
  edge: RStats;
  earlier: RStats;
  later: RStats;
  exitReasons: Record<string, number>;
  main: PortfolioSummary;
  small: PortfolioSummary;
  perYear: { year: string; trades: number; pnl: number; returnPct: number; sumR: number }[];
  curve: { date: string; equity: number }[];
  recent: { symbol: string; entryDate: string; exitDate: string; r: number; pnl: number; exitReason: string; shares: number }[];
};

export type BacktestResults = {
  /** Price source. Missing on runs made before the switch to full-market data, which used IEX only. */
  feed?: string;
  firstDate: string;
  lastDate: string;
  midDate: string;
  years: number;
  symbolsWithData: number;
  funnel: Funnel;
  assumptions: { slippagePct: number; entryWindowDays: number; timeStopDays: number; riskPct: number; maxPositions: number; maxPositionPct: number; weeklyLossLimitPct: number };
  accountUsd: number;
  smallAccountUsd: number;
  zarPerUsd: number;
  benchmark: { symbol: string; totalReturnPct: number; cagrPct: number } | null;
  variants: VariantResult[];
};

async function mapPool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const k = next++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

function sample<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, k) => points[Math.round(k * step)]);
}

const SLIPPAGE_PCT = 0.1;
const ENTRY_WINDOW_DAYS = 2;

export async function runBacktest(opts: { startYear: number }): Promise<number> {
  await ensureSchema();
  const db = requireDb();
  const settings = await loadSettings();
  const start = `${opts.startYear}-01-01`;
  const symbols = (await db.select({ symbol: schema.symbols.symbol }).from(schema.symbols).where(eq(schema.symbols.active, true))).map((r) => r.symbol);

  const data = await mapPool(symbols, 8, async (symbol) => {
    const rows = await db
      .select({ date: schema.bars.date, open: schema.bars.open, high: schema.bars.high, low: schema.bars.low, close: schema.bars.close, volume: schema.bars.volume })
      .from(schema.bars)
      .where(and(eq(schema.bars.symbol, symbol), gte(schema.bars.date, start)))
      .orderBy(schema.bars.date);
    return { symbol, bars: rows as OHLCV[] };
  });
  const withData = data.filter((d) => d.bars.length > 0);
  if (withData.length === 0) throw new Error("No price history in the database. Load history first.");

  let firstDate = "9999";
  let lastDate = "0000";
  for (const d of withData) {
    if (d.bars[0].date < firstDate) firstDate = d.bars[0].date;
    if (d.bars[d.bars.length - 1].date > lastDate) lastDate = d.bars[d.bars.length - 1].date;
  }
  const midDate = new Date((Date.parse(firstDate) + Date.parse(lastDate)) / 2).toISOString().slice(0, 10);
  const years = (Date.parse(lastDate) - Date.parse(firstDate)) / (365.25 * 86_400_000);

  const simCfg = { rules: settings, timeStopDays: settings.timeStopDays, slippagePct: SLIPPAGE_PCT, entryWindowDays: ENTRY_WINDOW_DAYS };
  const portfolioCfg = (startEquity: number): PortfolioConfig => ({
    startEquity, riskPct: settings.riskPct, maxPositionPct: settings.maxPositionPct,
    maxPositions: settings.maxPositions, weeklyLossLimitPct: settings.weeklyLossLimitPct,
  });
  const smallAccountUsd = Math.round(10_000 / settings.zarPerUsd);
  const summary = (p: ReturnType<typeof runPortfolio>): PortfolioSummary => ({
    startEquity: p.startEquity, finalEquity: p.finalEquity, totalReturnPct: p.totalReturnPct, cagrPct: p.cagrPct,
    maxDrawdownPct: p.maxDrawdownPct, taken: p.taken, skipped: p.skipped,
  });

  let funnel: Funnel = { signals: 0, rejected: {}, unfilled: 0, entered: 0 };
  const variants: VariantResult[] = [];
  for (const variant of VARIANTS) {
    const all: SimTrade[] = [];
    const vf: Funnel = { signals: 0, rejected: {}, unfilled: 0, entered: 0 };
    for (const d of withData) {
      const { trades, funnel: f } = simulateSymbol(d.symbol, d.bars, variant, simCfg);
      all.push(...trades);
      vf.signals += f.signals;
      vf.unfilled += f.unfilled;
      vf.entered += f.entered;
      for (const [k, n] of Object.entries(f.rejected)) vf.rejected[k] = (vf.rejected[k] ?? 0) + n;
    }
    if (variant === "fixed") funnel = vf;
    all.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
    const exitReasons: Record<string, number> = {};
    for (const t of all) exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;

    const main = runPortfolio(all, portfolioCfg(settings.accountUsd), firstDate, lastDate);
    const small = runPortfolio(all, portfolioCfg(smallAccountUsd), firstDate, lastDate);
    variants.push({
      variant,
      label: VARIANT_LABEL[variant],
      edge: summarizeR(all.map((t) => t.r)),
      earlier: summarizeR(all.filter((t) => t.entryDate < midDate).map((t) => t.r)),
      later: summarizeR(all.filter((t) => t.entryDate >= midDate).map((t) => t.r)),
      exitReasons,
      main: summary(main),
      small: summary(small),
      perYear: main.perYear,
      curve: sample(main.curve, 160),
      recent: main.done.slice(-15).reverse().map((t) => ({
        symbol: t.symbol, entryDate: t.entryDate, exitDate: t.exitDate, r: t.r, pnl: t.pnl, exitReason: t.exitReason, shares: t.shares,
      })),
    });
  }

  const spy = withData.find((d) => d.symbol === "SPY");
  const benchmark = spy && spy.bars.length > 1
    ? (() => {
        const g = spy.bars[spy.bars.length - 1].close / spy.bars[0].close;
        return { symbol: "SPY", totalReturnPct: (g - 1) * 100, cagrPct: (Math.pow(g, 1 / Math.max(years, 1 / 365)) - 1) * 100 };
      })()
    : null;

  const results: BacktestResults = {
    feed: DATA_FEED,
    firstDate, lastDate, midDate, years, symbolsWithData: withData.length, funnel,
    assumptions: {
      slippagePct: SLIPPAGE_PCT, entryWindowDays: ENTRY_WINDOW_DAYS, timeStopDays: settings.timeStopDays, riskPct: settings.riskPct,
      maxPositions: settings.maxPositions, maxPositionPct: settings.maxPositionPct, weeklyLossLimitPct: settings.weeklyLossLimitPct,
    },
    accountUsd: settings.accountUsd, smallAccountUsd, zarPerUsd: settings.zarPerUsd, benchmark, variants,
  };
  const [row] = await db
    .insert(schema.backtestRuns)
    .values({ params: { startYear: opts.startYear, symbols: symbols.length }, results })
    .returning({ id: schema.backtestRuns.id });
  return row.id;
}
