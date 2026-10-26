"use server";

import { redirect } from "next/navigation";
import { requireDb, schema } from "@/lib/db";
import { ensureSchema } from "@/lib/db/migrate";
import { STRATEGIES } from "@/lib/lab/strategies";

/** Opens the sealed 2023+ result for one strategy version. Recorded permanently; cannot be undone. */
export async function revealHoldout(form: FormData) {
  const strategy = String(form.get("strategy"));
  const runId = Number(form.get("runId"));
  const def = STRATEGIES.find((s) => s.id === strategy);
  if (!def || form.get("confirm") !== "yes" || !Number.isFinite(runId)) redirect("/lab");
  await ensureSchema();
  await requireDb().insert(schema.labReveals).values({ strategy: def.id, version: def.version, runId }).onConflictDoNothing();
  redirect(`/lab?run=${runId}#${def.id}`);
}
