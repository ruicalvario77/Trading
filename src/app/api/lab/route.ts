import { NextResponse } from "next/server";
import { runLab } from "@/lib/lab/run";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const origin = new URL(req.url).origin;
  try {
    const id = await runLab();
    return NextResponse.redirect(new URL(`/lab?run=${id}`, origin), 303);
  } catch (e) {
    const msg = `Lab run failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400);
    return NextResponse.redirect(new URL(`/lab?msg=${encodeURIComponent(msg)}`, origin), 303);
  }
}
