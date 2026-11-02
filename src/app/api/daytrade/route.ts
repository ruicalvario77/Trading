import { NextResponse } from "next/server";
import { runIntradayResearch } from "@/lib/intraday/run";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const origin = new URL(req.url).origin;
  const form = await req.formData();
  const months = [3, 6, 9].includes(Number(form.get("months"))) ? Number(form.get("months")) : 6;
  try {
    const id = await runIntradayResearch(months);
    return NextResponse.redirect(new URL(`/daytrade?run=${id}`, origin), 303);
  } catch (e) {
    return NextResponse.redirect(new URL(`/daytrade?msg=${encodeURIComponent(`Intraday backtest failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400))}`, origin), 303);
  }
}
