import test from "node:test";
import assert from "node:assert/strict";
import { nyOffsetMinutes, nyParts, buildSessions, inSession, type Session, type SBar } from "./session";
import { followLong, INTRADAY_SETUPS } from "./setups";

const ny = (date: string, hh: number, mm: number, offsetH: number) => Date.parse(`${date}T${String(hh - offsetH).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);

test("New York time across daylight saving", () => {
  assert.equal(nyOffsetMinutes(Date.parse("2026-07-15T14:00:00Z")), -240);
  assert.equal(nyOffsetMinutes(Date.parse("2026-12-01T14:30:00Z")), -300);
  assert.deepEqual(nyParts(Date.parse("2026-07-15T13:30:00Z")), { date: "2026-07-15", m: 570 });
  assert.deepEqual(nyParts(Date.parse("2026-12-01T14:30:00Z")), { date: "2026-12-01", m: 570 });
  assert.equal(inSession(Date.parse("2026-12-01T14:25:00Z")), false); // 09:25 pre-market
  assert.equal(inSession(Date.parse("2026-12-01T20:55:00Z")), true); // 15:55
});

/** A session of 78 five-minute bars from a price path; volume v(k). */
function day(date: string, px: (k: number) => number, v: (k: number) => number = () => 1000): SBar[] {
  return Array.from({ length: 78 }, (_, k) => {
    const o = px(k), c = px(k + 0.999);
    return { ts: ny(date, 9, 30, -5) + k * 300_000, m: 570 + 5 * k, o, h: Math.max(o, c) + 0.02, l: Math.min(o, c) - 0.02, c, v: v(k) };
  });
}
const session = (bars: SBar[], extra: Partial<Session> = {}): Session => ({ symbol: "X", date: "2026-12-01", bars, prevClose: 100, orVolAvg: 6000, ...extra });

test("sessions carry the previous close and the normal opening volume", () => {
  const raw = [];
  for (let d = 1; d <= 12; d++) {
    const date = `2026-12-${String(d).padStart(2, "0")}`;
    for (let k = -6; k < 84; k++) raw.push({ ts: ny(date, 9, 30, -5) + k * 300_000, o: 10, h: 10.1, l: 9.9, c: 10 + d / 100, v: 100 });
  }
  const s = buildSessions("X", raw);
  assert.equal(s.length, 12);
  assert.equal(s[0].bars.length, 78, "pre- and post-market bars dropped");
  assert.equal(s[1].prevClose, 10.01);
  assert.equal(s[10].orVolAvg, 600);
  assert.equal(s[5].orVolAvg, null, "needs 10 earlier sessions");
});

test("stop entry cannot hit the target on the entry bar; open entry can, stop first", () => {
  const bars = day("2026-12-01", () => 100);
  bars[10] = { ...bars[10], o: 100, h: 103, l: 99.9, c: 102 };
  const s = session(bars);
  const stopEntry = followLong(s, "t", 10, 100.5, 99.5, 101.5, false, 0);
  assert.notEqual(stopEntry.reason, "target", "target on the entry bar is not credited");
  const openEntry = followLong(s, "t", 10, 100, 99, 102, true, 0);
  assert.equal(openEntry.reason, "target");
  assert.equal(openEntry.r, 2);
});

test("opening range breakout: needs twice normal volume, buys the break, targets 2R", () => {
  const px = (k: number) => (k < 6 ? 100 + (k % 2) * 0.3 : 100.3 + (k - 6) * 0.15);
  const loud = session(day("2026-12-01", px, (k) => (k < 6 ? 2500 : 1000))); // 15,000 vs normal 6,000
  const t = INTRADAY_SETUPS.find((x) => x.id === "orb30")!.run(loud);
  assert.ok(t, "signal on a loud open");
  assert.equal(t!.reason, "target");
  // Costs of 0.05% a side are about 0.3R when the stop is only 0.34% away.
  assert.ok(t!.r > 1.6 && t!.r < 2, `r=${t!.r}`);
  const quiet = session(day("2026-12-01", px, () => 1000));
  assert.equal(INTRADAY_SETUPS.find((x) => x.id === "orb30")!.run(quiet), null, "normal volume is ignored");
});

test("gap and go and VWAP stretch fire only when their conditions hold", () => {
  const gapBars = day("2026-12-01", (k) => 104.6 + k * 0.05);
  gapBars[0] = { ...gapBars[0], o: 104, h: 104.6, l: 103.9, c: 104.5 }; // opens 4% up, first bar green, 0.7% range
  const gapUp = session(gapBars, { prevClose: 100 });
  assert.ok(INTRADAY_SETUPS.find((x) => x.id === "gap-go")!.run(gapUp));
  const noGap = session(day("2026-12-01", (k) => 101 + k * 0.02), { prevClose: 100 });
  assert.equal(INTRADAY_SETUPS.find((x) => x.id === "gap-go")!.run(noGap), null);
  const slide = session(day("2026-12-01", (k) => (k < 24 ? 100 : k < 40 ? 100 - (k - 23) * 0.2 : 97 + (k - 40) * 0.1)));
  const t = INTRADAY_SETUPS.find((x) => x.id === "vwap-stretch")!.run(slide);
  assert.ok(t, "signal on a 1.5% stretch");
  assert.ok(t!.entryM >= 630);
  const flat = session(day("2026-12-01", () => 100));
  assert.equal(INTRADAY_SETUPS.find((x) => x.id === "vwap-stretch")!.run(flat), null);
});
