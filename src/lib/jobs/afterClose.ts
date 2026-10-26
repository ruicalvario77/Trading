import { eq, sql } from "drizzle-orm";
import { requireDb, schema } from "../db";
import { ensureSchema } from "../db/migrate";
import { alpacaConfigured, getDailyBars } from "../alpaca";
import { UNIVERSE } from "../universe";
import { loadHistory } from "../backtest/data";
import type { OHLCV } from "../indicators";
import { refreshUniverse, universeAgeDays, type UniverseSummary } from "./universe";
import { backfillHistory, type BackfillSummary } from "./backfill";
import { trackSetups, type TrackSummary } from "../setups/run";
import { autoPaper, type AutoPaperSummary } from "../setups/paper";

export type AfterCloseSummary = {
  universe?: UniverseSummary | { error: string };
  symbols: number;
  barsUpserted: number;
  backfill?: BackfillSummary;
  track?: TrackSummary;
  paper?: AutoPaperSummary | { error: string };
  seconds: number;
};

/**
 * Nightly job after the US close:
 *  1. rebuild the whole-market universe once a week
 *  2. bring every symbol's prices up to date
 *  3. load missing history within a time budget (new symbols catch up over a few nights)
 *  4. move every setup's forward record on and record today's signals
 *  5. queue paper trades for setups that have earned it
 */
export async function runAfterClose(): Promise<AfterCloseSummary> {
  const t0 = Date.now();
  await ensureSchema();
  const db = requireDb();
  const out: AfterCloseSummary = { symbols: 0, barsUpserted: 0, seconds: 0 };

  await db.insert(schema.symbols).values(UNIVERSE.map((u) => ({ symbol: u.symbol, name: u.name, kind: u.kind, active: true }))).onConflictDoNothing();
  if (alpacaConfigured()) {
    const age = await universeAgeDays();
    if (age === null || age >= 6) {
      try { out.universe = await refreshUniverse(); } catch (e) { out.universe = { error: e instanceof Error ? e.message : String(e) }; }
    }
  }

  const active = (await db.select({ s: schema.symbols.symbol }).from(schema.symbols).where(eq(schema.symbols.active, true))).map((r) => r.s);
  out.symbols = active.length;
  const withBars = new Set((await db.select({ s: schema.bars.symbol }).from(schema.bars).groupBy(schema.bars.symbol)).map((r) => r.s));
  const existing = active.filter((s) => withBars.has(s));

  // Last ten days for symbols that already have history; late corrections land too.
  if (existing.length) {
    const start = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    const fetched = await getDailyBars(existing, start, new Date().toISOString().slice(0, 10));
    const rows: (typeof schema.bars.$inferInsert)[] = [];
    for (const [symbol, list] of Object.entries(fetched)) for (const b of list as OHLCV[]) rows.push({ symbol, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: Math.round(b.volume) });
    for (let i = 0; i < rows.length; i += 2000) {
      await db.insert(schema.bars).values(rows.slice(i, i + 2000)).onConflictDoUpdate({
        target: [schema.bars.symbol, schema.bars.date],
        set: { open: sql`excluded.open`, high: sql`excluded.high`, low: sql`excluded.low`, close: sql`excluded.close`, volume: sql`excluded.volume` },
      });
    }
    out.barsUpserted = rows.length;
  }

  // Whatever time is left before ~2.5 minutes goes to loading missing history.
  const left = 150_000 - (Date.now() - t0);
  if (left > 20_000) out.backfill = await backfillHistory(left);

  const since = new Date(Date.now() - 460 * 86_400_000).toISOString().slice(0, 10);
  const history = await loadHistory(db, active, since);
  out.track = await trackSetups(history);
  try { out.paper = await autoPaper(); } catch (e) { out.paper = { error: e instanceof Error ? e.message : String(e) }; }
  out.seconds = Math.round((Date.now() - t0) / 1000);
  return out;
}
