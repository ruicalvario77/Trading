import { NextResponse } from "next/server";
import { runSetupLab } from "@/lib/setups/run";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const origin = new URL(req.url).origin;
  try {
    const id = await runSetupLab();
    return NextResponse.redirect(new URL(`/setups?run=${id}`, origin), 303);
  } catch (e) {
    return NextResponse.redirect(new URL(`/setups?msg=${encodeURIComponent(`Setup backtest failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400))}`, origin), 303);
  }
}
