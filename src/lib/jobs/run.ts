import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { ensureSchema } from "../db/migrate";
import { runAfterClose } from "./afterClose";
import { placeApproved, syncTrades } from "./orders";
import { loadSettings } from "../settings";

export type JobName = "after-close" | "pre-open";

/** Runs a named job and records the outcome in job_runs. Never throws; the result carries the error. */
export async function runJob(job: JobName): Promise<{ ok: boolean; summary?: unknown; error?: string; runId?: number }> {
  const db = getDb();
  if (!db) return { ok: false, error: "DATABASE_URL is not set" };
  await ensureSchema();
  const [run] = await db.insert(schema.jobRuns).values({ job }).returning({ id: schema.jobRuns.id });
  try {
    let summary: Record<string, unknown>;
    if (job === "after-close") {
      const sync = await syncTrades();
      summary = { ...(await runAfterClose()), sync };
    } else {
      const sync = await syncTrades();
      const place = await placeApproved(await loadSettings());
      summary = { sync, place };
    }
    await db.update(schema.jobRuns).set({ ok: true, finishedAt: new Date(), summary }).where(eq(schema.jobRuns.id, run.id));
    return { ok: true, summary, runId: run.id };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.update(schema.jobRuns).set({ ok: false, finishedAt: new Date(), error }).where(eq(schema.jobRuns.id, run.id));
    return { ok: false, error, runId: run.id };
  }
}
