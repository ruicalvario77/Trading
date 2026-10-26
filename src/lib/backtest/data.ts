import { and, eq, gte } from "drizzle-orm";
import type { Db } from "../db";
import { schema } from "../db";
import type { OHLCV } from "../indicators";

export async function mapPool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
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

/** Daily bars per symbol from `start`, ascending. Symbols without data are left out. */
export async function loadHistory(db: Db, symbols: string[], start: string): Promise<Map<string, OHLCV[]>> {
  const rows = await mapPool(symbols, 8, async (symbol) => {
    const bars = await db
      .select({ date: schema.bars.date, open: schema.bars.open, high: schema.bars.high, low: schema.bars.low, close: schema.bars.close, volume: schema.bars.volume })
      .from(schema.bars)
      .where(and(eq(schema.bars.symbol, symbol), gte(schema.bars.date, start)))
      .orderBy(schema.bars.date);
    return [symbol, bars as OHLCV[]] as const;
  });
  return new Map(rows.filter(([, b]) => b.length > 0));
}
