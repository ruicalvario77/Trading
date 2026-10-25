import { NextResponse } from "next/server";
import { createSessionValue, passwordMatches, sessionCookieOptions, SESSION_COOKIE } from "@/lib/auth";

export async function POST(req: Request) {
  const form = await req.formData();
  const password = String(form.get("password") ?? "");
  const url = new URL(req.url);
  if (!passwordMatches(password)) return NextResponse.redirect(new URL("/login?error=1", url.origin), 303);
  const res = NextResponse.redirect(new URL("/", url.origin), 303);
  res.cookies.set(SESSION_COOKIE, await createSessionValue(), sessionCookieOptions());
  return res;
}
