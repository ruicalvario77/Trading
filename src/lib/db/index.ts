import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";
import { env } from "../env";

export type Db = NeonHttpDatabase<typeof schema>;

let cached: Db | null = null;

/** Returns null when DATABASE_URL is not set, so pages can render a setup state instead of crashing. */
export function getDb(): Db | null {
  const url = env("DATABASE_URL");
  if (!url) return null;
  if (!cached) cached = drizzle(neon(url), { schema });
  return cached;
}

export function requireDb(): Db {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not set");
  return db;
}

export { schema };
