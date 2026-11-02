import type { IntradayBar } from "../alpaca";

/** A bar inside the regular session, with its start time in minutes after midnight New York time. */
export type SBar = IntradayBar & { m: number };
export type Session = {
  symbol: string;
  date: string; // New York trading date
  bars: SBar[]; // 09:30 to 16:00 only, in order
  prevClose: number | null;
  /** Average opening-range (first 30 minutes) volume over up to the previous 20 sessions. */
  orVolAvg: number | null;
};

export const OPEN_M = 9 * 60 + 30;
export const CLOSE_M = 16 * 60;
export const OR_END_M = 10 * 60;

const offsetCache = new Map<string, number>();
const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false });

/** New York's offset from UTC in minutes on the UTC date of `ts` (-240 in summer, -300 in winter). */
export function nyOffsetMinutes(ts: number): number {
  const key = new Date(ts).toISOString().slice(0, 10);
  let off = offsetCache.get(key);
  if (off === undefined) {
    const noon = Date.parse(`${key}T12:00:00Z`);
    const h = Number(fmt.format(new Date(noon)).replace(/\D/g, "")) % 24;
    off = (h - 12) * 60;
    offsetCache.set(key, off);
  }
  return off;
}

export function nyParts(ts: number): { date: string; m: number } {
  const local = new Date(ts + nyOffsetMinutes(ts) * 60_000);
  return { date: local.toISOString().slice(0, 10), m: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

/** True for bars that start inside the regular session. Used to drop pre- and post-market bars early. */
export function inSession(ts: number): boolean {
  const { m } = nyParts(ts);
  return m >= OPEN_M && m < CLOSE_M;
}

/** Groups one symbol's bars into sessions and adds the previous close and normal opening volume. */
export function buildSessions(symbol: string, bars: IntradayBar[]): Session[] {
  const byDate = new Map<string, SBar[]>();
  for (const b of bars) {
    const { date, m } = nyParts(b.ts);
    if (m < OPEN_M || m >= CLOSE_M) continue;
    (byDate.get(date) ?? byDate.set(date, []).get(date)!).push({ ...b, m });
  }
  const dates = [...byDate.keys()].sort();
  const sessions: Session[] = [];
  const orVols: number[] = [];
  for (const date of dates) {
    const sb = byDate.get(date)!.sort((a, b) => a.ts - b.ts);
    const prev = sessions[sessions.length - 1];
    const recent = orVols.slice(-20);
    sessions.push({
      symbol, date, bars: sb,
      prevClose: prev ? prev.bars[prev.bars.length - 1].c : null,
      orVolAvg: recent.length >= 10 ? recent.reduce((a, b) => a + b, 0) / recent.length : null,
    });
    orVols.push(sb.filter((b) => b.m < OR_END_M).reduce((a, b) => a + b.v, 0));
  }
  return sessions;
}

export const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
