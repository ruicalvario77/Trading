import { handleCron } from "@/lib/cron";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export const GET = (req: Request) => handleCron(req, "pre-open");
export const POST = GET;
