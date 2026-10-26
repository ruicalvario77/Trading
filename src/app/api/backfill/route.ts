import { NextResponse } from "next/server";
import { backfillHistory } from "@/lib/jobs/backfill";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const origin = new URL(req.url).origin;
  const back = (await req.formData().catch(() => null))?.get("back") === "setups" ? "/setups" : "/backtest";
  try {
    const r = await backfillHistory();
    const msg = r.remaining > 0
      ? `Loaded ${r.processed} symbols (${r.rows.toLocaleString()} bars). ${r.remaining} still to go. Press Load history again to continue.`
      : `History complete for all ${r.total} symbols. ${r.rows ? `Added ${r.rows.toLocaleString()} bars.` : ""}`;
    return NextResponse.redirect(new URL(`${back}?msg=${encodeURIComponent(msg)}`, origin), 303);
  } catch (e) {
    const msg = `Loading history failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400);
    return NextResponse.redirect(new URL(`${back}?msg=${encodeURIComponent(msg)}`, origin), 303);
  }
}
