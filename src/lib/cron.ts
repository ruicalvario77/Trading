import { NextResponse } from "next/server";
import { env } from "./env";
import { SESSION_COOKIE, verifySessionValue } from "./auth";
import { runJob, type JobName } from "./jobs/run";

function cookieValue(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Accepts Vercel Cron (bearer CRON_SECRET) or a logged-in user clicking "run now". */
export async function handleCron(req: Request, job: JobName): Promise<Response> {
  const secret = env("CRON_SECRET");
  const bearer = req.headers.get("authorization");
  const fromCron = !!secret && bearer === `Bearer ${secret}`;
  const fromUser = await verifySessionValue(cookieValue(req, SESSION_COOKIE));
  if (!fromCron && !fromUser) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const result = await runJob(job);
  const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
  if (wantsHtml) {
    const url = new URL(req.url);
    return NextResponse.redirect(new URL(`/?job=${job}&ok=${result.ok ? 1 : 0}`, url.origin), 303);
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
