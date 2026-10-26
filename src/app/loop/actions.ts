"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireDb } from "@/lib/db";
import { ensureSchema } from "@/lib/db/migrate";
import { pauseLoop, runResearch, startLoop } from "@/lib/loop/run";

const back = (msg: string) => redirect(`/loop?msg=${encodeURIComponent(msg.slice(0, 400))}`);

export async function startAction(form: FormData) {
  if (form.get("confirm") !== "yes") back("Tick the box to confirm.");
  let msg: string;
  try {
    const r = await startLoop();
    msg = r.errors.length
      ? `Paper trading is on, with problems: ${r.errors.join("; ")}`
      : `Paper trading is on. ${r.ordersPlaced ?? 0} order${r.ordersPlaced === 1 ? "" : "s"} queued for the next US open (15:30 SAST).`;
  } catch (e) {
    msg = `Could not start: ${e instanceof Error ? e.message : String(e)}`;
  }
  revalidatePath("/loop");
  back(msg);
}

export async function pauseAction() {
  await pauseLoop();
  revalidatePath("/loop");
  back("Paper trading paused. Current holdings stay as they are; no new orders until you resume.");
}

export async function researchAction() {
  let msg: string;
  try {
    await ensureSchema();
    const r = await runResearch(requireDb());
    msg = `Re-tested ${r.configsTested} rule sets on data to ${r.asOf}. Champion: ${r.champion.label}.`;
  } catch (e) {
    msg = `Research failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  revalidatePath("/loop");
  back(msg);
}
