"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDb, schema } from "@/lib/db";
import { loadSettings } from "@/lib/settings";
import { committedCount, weekPnl } from "@/lib/jobs/orders";
import { limitBlock } from "@/lib/trades";

export async function approveCandidate(form: FormData) {
  const id = Number(form.get("id"));
  const db = requireDb();
  const [c] = await db.select().from(schema.candidates).where(eq(schema.candidates.id, id)).limit(1);
  if (!c || c.status !== "new" || !c.tradeable) redirect("/candidates?msg=not-approvable");
  const s = await loadSettings();
  const block = limitBlock({
    committed: await committedCount(), maxPositions: s.maxPositions, weekPnlUsd: await weekPnl(),
    accountUsd: s.accountUsd, weeklyLossLimitPct: s.weeklyLossLimitPct,
  });
  if (block) redirect(`/candidates?msg=${encodeURIComponent(block)}`);
  await db.update(schema.candidates).set({ status: "approved" }).where(and(eq(schema.candidates.id, id), eq(schema.candidates.status, "new")));
  revalidatePath("/candidates");
  redirect(`/candidates?msg=${encodeURIComponent(`${c.symbol} approved. The pre-open job sends its bracket order at 15:00 SAST.`)}`);
}

export async function setCandidateStatus(form: FormData) {
  const id = Number(form.get("id"));
  const to = String(form.get("to"));
  const from = to === "new" ? "approved" : "new";
  if (to !== "rejected" && to !== "new") redirect("/candidates");
  const db = requireDb();
  await db.update(schema.candidates).set({ status: to }).where(and(eq(schema.candidates.id, id), eq(schema.candidates.status, from)));
  revalidatePath("/candidates");
  redirect("/candidates");
}
