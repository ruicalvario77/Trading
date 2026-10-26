import { NextResponse } from "next/server";
import { runBacktest } from "@/lib/backtest/run";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const origin = new URL(req.url).origin;
  const form = await req.formData();
  const year = Math.min(Math.max(Number(form.get("startYear")) || 2016, 2016), new Date().getUTCFullYear() - 1);
  try {
    const id = await runBacktest({ startYear: year });
    return NextResponse.redirect(new URL(`/backtest?run=${id}`, origin), 303);
  } catch (e) {
    const msg = `Backtest failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400);
    return NextResponse.redirect(new URL(`/backtest?msg=${encodeURIComponent(msg)}`, origin), 303);
  }
}
