import { NextResponse } from "next/server";
import { refreshUniverse } from "@/lib/jobs/universe";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const origin = new URL(req.url).origin;
  let msg: string;
  try {
    const r = await refreshUniverse();
    msg = `Checked ${r.checked.toLocaleString()} of ${r.listed.toLocaleString()} listed stocks and ETFs. ${r.liquid.toLocaleString()} are liquid enough to trade (${r.added} added, ${r.dropped} dropped). Next: load history.`;
  } catch (e) {
    msg = `Universe rebuild failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  return NextResponse.redirect(new URL(`/setups?msg=${encodeURIComponent(msg.slice(0, 400))}`, origin), 303);
}
