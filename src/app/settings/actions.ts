"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { saveSettings } from "@/lib/settings";

const num = (f: FormData, k: string, min: number, max: number) => {
  const v = Number(f.get(k));
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${k} must be between ${min} and ${max}`);
  return v;
};

export async function updateSettings(form: FormData) {
  await saveSettings({
    accountUsd: num(form, "accountUsd", 50, 10_000_000),
    zarPerUsd: num(form, "zarPerUsd", 1, 100),
    riskPct: num(form, "riskPct", 0.1, 5),
    maxPositions: Math.round(num(form, "maxPositions", 1, 20)),
    weeklyLossLimitPct: num(form, "weeklyLossLimitPct", 0.5, 20),
    maxPositionPct: num(form, "maxPositionPct", 5, 100),
    minPrice: num(form, "minPrice", 1, 1000),
    maxPrice: num(form, "maxPrice", 2, 10_000),
    minAvgVolume: Math.round(num(form, "minAvgVolume", 0, 1_000_000_000)),
    targetR: num(form, "targetR", 1, 5),
    timeStopDays: Math.round(num(form, "timeStopDays", 2, 60)),
  });
  revalidatePath("/");
  revalidatePath("/settings");
  redirect("/settings?saved=1");
}
