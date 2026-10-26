"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { syncTrades } from "@/lib/jobs/orders";

export async function syncNow() {
  const r = await syncTrades();
  revalidatePath("/positions");
  const msg = r.errors.length
    ? `Sync finished with errors: ${r.errors.join("; ").slice(0, 300)}`
    : `Checked ${r.checked}. Filled ${r.filled}, closed ${r.closed}, cancelled ${r.cancelled + r.expired}.`;
  redirect(`/positions?msg=${encodeURIComponent(msg)}`);
}
