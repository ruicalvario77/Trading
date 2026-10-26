import { eq, inArray, notInArray, sql } from "drizzle-orm";
import { requireDb, rawSql, schema } from "../db";
import { ensureSchema } from "../db/migrate";
import { getAssets, getDailyBars } from "../alpaca";
import { mapPool } from "../backtest/data";
import { LOOP_SYMBOLS } from "../loop/families";
import { UNIVERSE } from "../universe";

/** Tradable means: a real exchange listing, at least $5, and at least $20 million traded a day on average. */
export const MIN_PRICE = 5;
export const MIN_DOLLAR_VOLUME = 20_000_000;
const EXCHANGES = new Set(["NYSE", "NASDAQ", "ARCA", "AMEX", "BATS"]);
/** Daily history kept for the whole market. The learning loop's ETFs keep history back to 2016. */
export const MARKET_HISTORY_YEARS = 4;

export function marketHistoryStart(now = new Date()): string {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - MARKET_HISTORY_YEARS);
  return d.toISOString().slice(0, 10);
}

export type UniverseSummary = { listed: number; checked: number; liquid: number; added: number; dropped: number; prunedBars: number };

/**
 * Rebuilds the tradable universe from every US-listed stock and ETF: fetches the last month of prices
 * for all of them and keeps those that pass the price and dollar-volume rules. The loop's ETFs always stay.
 */
export async function refreshUniverse(): Promise<UniverseSummary> {
  await ensureSchema();
  const db = requireDb();
  const assets = (await getAssets()).filter((a) => a.tradable && a.status === "active" && EXCHANGES.has(a.exchange) && /^[A-Z.]+$/.test(a.symbol));
  const names = new Map(assets.map((a) => [a.symbol, a.name]));
  const start = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);

  const chunks: string[][] = [];
  for (let i = 0; i < assets.length; i += 100) chunks.push(assets.slice(i, i + 100).map((a) => a.symbol));
  const stats = new Map<string, { adv: number; close: number }>();
  await mapPool(chunks, 4, async (syms) => {
    const bars = await getDailyBars(syms, start, end);
    for (const [s, b] of Object.entries(bars)) {
      const last = b.slice(-20);
      if (!last.length) continue;
      const adv = last.reduce((t, x) => t + x.close * x.volume, 0) / last.length;
      stats.set(s, { adv, close: last[last.length - 1].close });
    }
  });

  const keep = new Set(LOOP_SYMBOLS);
  for (const [s, v] of stats) if (v.close >= MIN_PRICE && v.adv >= MIN_DOLLAR_VOLUME) keep.add(s);
  const etfs = new Set(UNIVERSE.filter((u) => u.kind === "etf").map((u) => u.symbol));
  const before = new Set((await db.select({ s: schema.symbols.symbol }).from(schema.symbols).where(eq(schema.symbols.active, true))).map((r) => r.s));

  const now = new Date();
  const rows = [...keep].map((symbol) => ({
    symbol,
    name: names.get(symbol) ?? null,
    kind: etfs.has(symbol) || /\bETF\b|\bFund\b|\bTrust\b/i.test(names.get(symbol) ?? "") ? "etf" : "stock",
    active: true,
    avgDollarVolume: stats.get(symbol)?.adv ?? null,
    lastClose: stats.get(symbol)?.close ?? null,
    refreshedAt: now,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(schema.symbols).values(rows.slice(i, i + 500)).onConflictDoUpdate({
      target: schema.symbols.symbol,
      set: { name: sql`excluded.name`, kind: sql`excluded.kind`, active: true, avgDollarVolume: sql`excluded.avg_dollar_volume`, lastClose: sql`excluded.last_close`, refreshedAt: now },
    });
  }
  const keepList = [...keep];
  await db.update(schema.symbols).set({ active: false }).where(notInArray(schema.symbols.symbol, keepList));

  // Keep storage inside the free database: drop bars older than the market window, except the loop's ETFs,
  // and drop all bars of symbols that left the universe.
  const raw = rawSql();
  const [p1] = (await raw.query(
    "WITH d AS (DELETE FROM bars WHERE date < $1 AND NOT (symbol = ANY($2)) RETURNING 1) SELECT count(*)::int AS n FROM d",
    [marketHistoryStart(), LOOP_SYMBOLS],
  )) as { n: number }[];
  const gone = [...before].filter((s) => !keep.has(s));
  let goneRows = 0;
  if (gone.length) {
    const [p2] = (await raw.query("WITH d AS (DELETE FROM bars WHERE symbol = ANY($1) RETURNING 1) SELECT count(*)::int AS n FROM d", [gone])) as { n: number }[];
    goneRows = p2.n;
    await db.delete(schema.backfills).where(inArray(schema.backfills.symbol, gone));
  }

  return {
    listed: assets.length, checked: stats.size, liquid: keep.size,
    added: keepList.filter((s) => !before.has(s)).length, dropped: gone.length, prunedBars: p1.n + goneRows,
  };
}

/** Days since the universe was last rebuilt, or null if never. */
export async function universeAgeDays(): Promise<number | null> {
  const db = requireDb();
  const [r] = await db.select({ t: sql<string | null>`max(${schema.symbols.refreshedAt})` }).from(schema.symbols);
  return r?.t ? (Date.now() - new Date(r.t).getTime()) / 86_400_000 : null;
}
