import { env } from "./env";

export const SESSION_COOKIE = "trading_session";
const SESSION_DAYS = 30;

const enc = new TextEncoder();

async function sign(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret + ":session"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function passwordMatches(candidate: string): boolean {
  const expected = env("APP_PASSWORD");
  return !!expected && equal(candidate, expected);
}

export async function createSessionValue(): Promise<string> {
  const secret = env("APP_PASSWORD");
  if (!secret) throw new Error("APP_PASSWORD is not set");
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  return `${exp}.${await sign(String(exp), secret)}`;
}

export async function verifySessionValue(value: string | undefined): Promise<boolean> {
  const secret = env("APP_PASSWORD");
  if (!secret || !value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return equal(sig, await sign(exp, secret));
}

export function sessionCookieOptions() {
  return { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_DAYS * 86_400 };
}
