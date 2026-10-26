"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDb, schema } from "@/lib/db";
import { ensureSchema } from "@/lib/db/migrate";

export async function saveJournal(form: FormData) {
  await ensureSchema();
  const db = requireDb();
  const tradeId = Number(form.get("tradeId"));
  const rulesFollowed = form.get("rulesFollowed") === "yes";
  const brokenRule = rulesFollowed ? null : String(form.get("brokenRule") ?? "").trim().slice(0, 200) || null;
  const note = String(form.get("note") ?? "").trim().slice(0, 1000) || null;
  const [existing] = await db.select({ id: schema.journal.id }).from(schema.journal).where(eq(schema.journal.tradeId, tradeId)).limit(1);
  if (existing) await db.update(schema.journal).set({ rulesFollowed, brokenRule, note }).where(eq(schema.journal.id, existing.id));
  else await db.insert(schema.journal).values({ tradeId, rulesFollowed, brokenRule, note });
  revalidatePath("/journal");
  redirect("/journal");
}
