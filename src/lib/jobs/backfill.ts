import { eq } from "drizzle-orm";
import { requireDb, schema } from "../db";
import { ensureSchema } from "../db/migrate";
import { getDailyBars } from "../alpaca";

export const HISTORY_START = "2016-01-01";

export type BackfillSummary = { processed: number; remaining: number; rows: number; total: number };

/**
 * Loads daily history back to HISTORY_START for every symbol not yet done, in groups, stopping when the
 * time budget runs out. Run it again to continue. Symbols with shorter histories are marked done with
 * whatever exists.
 */
export async function backfillHistory(budgetMs = 230_000): Promise<BackfillSummary> {
  await ensureSchema();
  const db = requireDb();
  const t0 = Date.now();
  const active = (await db.select({ symbol: schema.symbols.symbol }).from(schema.symbols).where(eq(schema.symbols.active, true))).map((r) => r.symbol);
  const done = new Set((await db.select({ symbol: schema.backfills.symbol }).from(schema.backfills)).map((r) => r.symbol));
  const todo = active.filter((s) => !done.has(s));
  const today = new Date().toISOString().slice(0, 10);

  let rows = 0;
  let processed = 0;
  for (let i = 0; i < todo.length && Date.now() - t0 < budgetMs; i += 20) {
    const group = todo.slice(i, i + 20);
    const fetched = await getDailyBars(group, HISTORY_START, today);
    const values: (typeof schema.bars.$inferInsert)[] = [];
    for (const [symbol, list] of Object.entries(fetched)) {
      for (const b of list) values.push({ symbol, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: Math.round(b.volume) });
    }
    const chunks: (typeof values)[] = [];
    for (let k = 0; k < values.length; k += 2000) chunks.push(values.slice(k, k + 2000));
    for (let k = 0; k < chunks.length; k += 4) {
      await Promise.all(chunks.slice(k, k + 4).map((c) => db.insert(schema.bars).values(c).onConflictDoNothing()));
    }
    rows += values.length;
    await db
      .insert(schema.backfills)
      .values(group.map((symbol) => ({ symbol, earliest: fetched[symbol]?.[0]?.date ?? null })))
      .onConflictDoNothing();
    processed += group.length;
  }
  return { processed, remaining: todo.length - processed, rows, total: active.length };
}
