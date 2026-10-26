import { and, eq, gte, inArray, sql, desc } from "drizzle-orm";
import { requireDb, schema } from "../db";
import { ensureSchema } from "../db/migrate";
import { getDailyBars } from "../alpaca";
import { UNIVERSE } from "../universe";
import { evaluatePullback, MIN_HISTORY } from "../strategy/pullback";
import { planTrade } from "../planner";
import { loadSettings } from "../settings";
import type { OHLCV } from "../indicators";

export type AfterCloseSummary = {
  tradeDate: string | null;
  symbols: number;
  barsFetched: number;
  barsUpserted: number;
  withEnoughHistory: number;
  passedSetup: number;
  candidates: number;
  tradeable: number;
  skippedReasons: Record<string, number>;
};

const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const isoToday = () => new Date().toISOString().slice(0, 10);

/**
 * Nightly job: make sure the schema exists, sync daily bars, run the scanner, store ranked candidates.
 * Position management and stale-order cleanup join this job in milestone 4.
 */
export async function runAfterClose(): Promise<AfterCloseSummary> {
  await ensureSchema();
  const db = requireDb();
  const settings = await loadSettings();

  // 1. Universe
  await db
    .insert(schema.symbols)
    .values(UNIVERSE.map((u) => ({ symbol: u.symbol, name: u.name, kind: u.kind, active: true })))
    .onConflictDoNothing();
  const active = (await db.select({ symbol: schema.symbols.symbol }).from(schema.symbols).where(eq(schema.symbols.active, true))).map((r) => r.symbol);

  // 2. Incremental sync. Symbols with no history get 460 calendar days (about 320 trading days).
  const latest = await db
    .select({ symbol: schema.bars.symbol, last: sql<string>`max(${schema.bars.date})` })
    .from(schema.bars)
    .groupBy(schema.bars.symbol);
  const lastBySymbol = new Map(latest.map((r) => [r.symbol, r.last]));
  const fresh = active.filter((s) => !lastBySymbol.has(s));
  const existing = active.filter((s) => lastBySymbol.has(s));
  const today = isoToday();

  let barsFetched = 0;
  let barsUpserted = 0;
  const upsert = async (fetched: Record<string, OHLCV[]>) => {
    const rows: (typeof schema.bars.$inferInsert)[] = [];
    for (const [symbol, list] of Object.entries(fetched)) {
      for (const b of list) rows.push({ symbol, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: Math.round(b.volume) });
    }
    barsFetched += rows.length;
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      await db
        .insert(schema.bars)
        .values(chunk)
        .onConflictDoUpdate({
          target: [schema.bars.symbol, schema.bars.date],
          set: {
            open: sql`excluded.open`, high: sql`excluded.high`, low: sql`excluded.low`, close: sql`excluded.close`, volume: sql`excluded.volume`,
          },
        });
      barsUpserted += chunk.length;
    }
  };

  if (fresh.length) await upsert(await getDailyBars(fresh, isoDaysAgo(460), today));
  if (existing.length) {
    // Refetch from the oldest "last bar" among existing symbols, minus a few days, so late corrections land too.
    const oldest = [...lastBySymbol.values()].sort()[0];
    const start = new Date(new Date(oldest).getTime() - 5 * 86_400_000).toISOString().slice(0, 10);
    await upsert(await getDailyBars(existing, start, today));
  }

  // 3. Load history and scan
  const cutoff = isoDaysAgo(420);
  const history = await db
    .select()
    .from(schema.bars)
    .where(and(gte(schema.bars.date, cutoff), inArray(schema.bars.symbol, active)))
    .orderBy(schema.bars.symbol, schema.bars.date);

  const bySymbol = new Map<string, OHLCV[]>();
  let tradeDate: string | null = null;
  for (const r of history) {
    (bySymbol.get(r.symbol) ?? bySymbol.set(r.symbol, []).get(r.symbol)!).push(r);
    if (!tradeDate || r.date > tradeDate) tradeDate = r.date;
  }

  const skippedReasons: Record<string, number> = {};
  let withEnoughHistory = 0;
  let passedSetup = 0;
  const found: (typeof schema.candidates.$inferInsert)[] = [];

  if (tradeDate) {
    for (const [symbol, list] of bySymbol) {
      if (list.length < MIN_HISTORY || list[list.length - 1].date !== tradeDate) continue;
      withEnoughHistory++;
      const setup = evaluatePullback(list);
      if (!setup.ok) {
        const key = setup.reason;
        skippedReasons[key] = (skippedReasons[key] ?? 0) + 1;
        continue;
      }
      passedSetup++;
      const plan = planTrade(setup, settings);
      found.push({
        scanId: 0, tradeDate, symbol, close: setup.close, score: setup.score,
        entry: plan.entry, stop: plan.stop, target: plan.target, shares: plan.shares,
        riskUsd: plan.riskUsd, positionUsd: plan.positionUsd, tradeable: plan.tradeable, reasons: plan.reasons, status: "new",
      });
    }
    found.sort((a, b) => Number(b.tradeable) - Number(a.tradeable) || b.score - a.score);

    // Replace any earlier "new" candidates, for this date or older ones that were never acted on.
    await db.update(schema.candidates).set({ status: "expired" }).where(eq(schema.candidates.status, "new"));
    const [scan] = await db
      .insert(schema.scans)
      .values({ tradeDate, universeSize: active.length, withEnoughHistory, passedFilters: passedSetup, candidateCount: found.length })
      .returning({ id: schema.scans.id });
    if (found.length) await db.insert(schema.candidates).values(found.map((c) => ({ ...c, scanId: scan.id })));
  }

  return {
    tradeDate, symbols: active.length, barsFetched, barsUpserted, withEnoughHistory, passedSetup,
    candidates: found.length, tradeable: found.filter((c) => c.tradeable).length, skippedReasons,
  };
}

export async function latestScan() {
  const db = requireDb();
  const rows = await db.select().from(schema.scans).orderBy(desc(schema.scans.id)).limit(1);
  return rows[0] ?? null;
}
