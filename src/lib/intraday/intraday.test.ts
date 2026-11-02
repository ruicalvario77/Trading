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

test("last half hour: buys index ETFs at 15:30 only when up at 10:00, sells at the close", async () => {
  const { INTRADAY_SETUPS: S } = await import("./setups");
  const lh = S.find((x) => x.id === "last-half")!;
  // Up at 10:00, then a 1.5% rise in the last half hour (more than the 0.1% round-trip cost).
  const up = session(day("2026-12-01", (k) => (k < 72 ? 101 + k * 0.01 : 101.72 + (k - 72) * 0.3)), { symbol: "SPY", prevClose: 100 });
  const t = lh.run(up)!;
  assert.equal(t.entryM, 930);
  assert.equal(t.reason, "close");
  assert.ok(t.r > 0);
  assert.equal(lh.run(session(day("2026-12-01", (k) => 99 + k * 0.01), { symbol: "SPY", prevClose: 100 })), null, "down at 10:00");
  assert.equal(lh.run(session(day("2026-12-01", (k) => 101 + k * 0.01), { symbol: "AAPL", prevClose: 100 })), null, "index ETFs only");
  assert.equal(lh.run(session(day("2026-12-01", (k) => 101).slice(0, 42), { symbol: "SPY", prevClose: 100 })), null, "early close skipped");
});

test("stocks in play: open time, ranking, context and the trade", async () => {
  const { openUtc, pickInPlay, dailyContext } = await import("./rvol");
  const { runRvolOrb } = await import("./setups");
  assert.equal(new Date(openUtc("2026-07-15")).toISOString(), "2026-07-15T13:30:00.000Z");
  assert.equal(new Date(openUtc("2026-12-01")).toISOString(), "2026-12-01T14:30:00.000Z");
  const daily = new Map([["A", Array.from({ length: 20 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, "0")}`, open: 50, high: 51, low: 49, close: 50, volume: 2_000_000 }))]]);
  const ctx = dailyContext(daily);
  assert.deepEqual(ctx.get("A")!.get("2026-11-20"), { atr: 2, vol14: 2_000_000 }, "as of the previous close");
  const bar = (v: number, o = 50) => ({ ts: 0, o, h: o + 0.5, l: o - 0.5, c: o + 0.2, v });
  const ctxMany = new Map(["A", "B", "C", "D"].map((s) => [s, new Map([["2026-11-20", { atr: s === "D" ? 0.3 : 2, vol14: 2_000_000 }]])]));
  const picks = pickInPlay({ A: bar(100_000), B: bar(400_000), C: bar(300_000, 4), D: bar(900_000) }, ctxMany, "2026-11-20");
  assert.deepEqual(picks, ["B", "A"], "C is under $5, D's ATR is under $0.50");
  const s = session(day("2026-12-01", (k) => 50 + k * 0.05));
  s.bars[0] = { ...s.bars[0], o: 50, h: 50.1, l: 49.9, c: 50.05 };
  const t = runRvolOrb(s, 2)!;
  assert.ok(Math.abs(t.stop - (t.entry / 1.0005 - 0.2)) < 0.01, "stop 10% of ATR below entry");
  assert.equal(t.reason, "close");
  assert.ok(t.r > 0);
  const red = session(day("2026-12-01", (k) => 50 - k * 0.05));
  assert.equal(runRvolOrb(red, 2), null, "red first bar is not traded long");
});

test("stocks in play on one-minute bars: a dip before the breakout no longer counts as a stop", async () => {
  const { runRvolOrb } = await import("./setups");
  // First five one-minute bars: high 50.25, so the trigger is 50.26 and the stop 50.06 (10% of a $2 ATR).
  // Minute 6 dips to 49.90 (below the stop) and recovers; minute 7 breaks out with its low above the stop.
  const mk = (i: number, o: number, h: number, l: number, c: number) => ({ ts: 0, m: 570 + i, o, h, l, c, v: 1000 });
  const bars = [mk(0, 50, 50.1, 49.95, 50.05), mk(1, 50.05, 50.15, 50, 50.1), mk(2, 50.1, 50.2, 50.05, 50.15), mk(3, 50.15, 50.25, 50.1, 50.2), mk(4, 50.2, 50.22, 50.15, 50.2),
    mk(5, 50.2, 50.2, 49.9, 50.15), mk(6, 50.15, 50.4, 50.12, 50.35)];
  for (let i = 7; i < 390; i++) bars.push(mk(i, 50.35 + (i - 7) * 0.003, 50.36 + (i - 7) * 0.003, 50.34 + (i - 7) * 0.003, 50.35 + (i - 7) * 0.003));
  const t = runRvolOrb({ symbol: "X", date: "2026-12-01", bars, prevClose: 50, orVolAvg: null }, 2)!;
  assert.equal(t.entryM, 576, "entered on the minute that broke out, after the dip");
  assert.equal(t.reason, "close");
  assert.ok(t.r > 0);
});
