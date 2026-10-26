"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { requireDb, schema } from "@/lib/db";
import { ensureSchema } from "@/lib/db/migrate";
import { STRATEGIES } from "@/lib/lab/strategies";
import type { LabResults } from "@/lib/lab/run";

/** Opens the sealed 2023+ result for one strategy version. Recorded permanently; cannot be undone. */
export async function revealHoldout(form: FormData) {
  const strategy = String(form.get("strategy"));
  const runId = Number(form.get("runId"));
  const def = STRATEGIES.find((s) => s.id === strategy);
  if (!def || form.get("confirm") !== "yes" || !Number.isFinite(runId)) redirect("/lab");
  await ensureSchema();
  const db = requireDb();
  const [run] = await db.select().from(schema.labRuns).where(eq(schema.labRuns.id, runId)).limit(1);
  const res = run?.results as LabResults | undefined;
  // A seal can only be opened once, so never spend it on a run whose build period is too short to mean anything.
  if (!res || !res.feed || res.start > "2018-12-31") redirect(`/lab?msg=${encodeURIComponent("That run's build period is too short to judge. Load full history and run the lab again first.")}`);
  await db.insert(schema.labReveals).values({ strategy: def.id, version: def.version, runId }).onConflictDoNothing();
  redirect(`/lab?run=${runId}#${def.id}`);
}
