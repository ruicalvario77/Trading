import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { Settings } from "./db/schema";
import { DEFAULT_RULES } from "./planner";

/** R10,000 at roughly 18 rand per dollar. The owner adjusts both on the settings page. */
export const DEFAULT_SETTINGS: Settings = {
  id: 1,
  accountUsd: DEFAULT_RULES.accountUsd,
  zarPerUsd: 18.0,
  riskPct: DEFAULT_RULES.riskPct,
  maxPositions: 5,
  weeklyLossLimitPct: 4,
  maxPositionPct: DEFAULT_RULES.maxPositionPct,
  minPrice: DEFAULT_RULES.minPrice,
  maxPrice: DEFAULT_RULES.maxPrice,
  minAvgVolume: DEFAULT_RULES.minAvgVolume,
  targetR: DEFAULT_RULES.targetR,
  timeStopDays: 10,
  updatedAt: new Date(0),
};

export async function loadSettings(): Promise<Settings> {
  const db = getDb();
  if (!db) return DEFAULT_SETTINGS;
  const rows = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1);
  if (rows.length === 0) {
    await db.insert(schema.settings).values(DEFAULT_SETTINGS).onConflictDoNothing();
    return DEFAULT_SETTINGS;
  }
  return rows[0];
}

export async function saveSettings(next: Omit<Settings, "id" | "updatedAt">): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not set");
  await db
    .insert(schema.settings)
    .values({ id: 1, ...next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.id, set: { ...next, updatedAt: new Date() } });
}

export function zar(usd: number, rate: number): string {
  return `R${(usd * rate).toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`;
}
