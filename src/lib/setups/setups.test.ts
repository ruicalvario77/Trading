import test from "node:test";
import assert from "node:assert/strict";
import { runPlan, dailyT, luckBarT, judge, backtestSymbol } from "./engine";
import { SETUPS, prepare, marketCtx, type Plan } from "./library";
import { rsiSeries, rollingExtreme } from "../indicators";
import { summarizeR } from "../stats";
import type { OHLCV } from "../indicators";

const bar = (date: string, o: number, h: number, l: number, c: number, v = 1e6): OHLCV => ({ date, open: o, high: h, low: l, close: c, volume: v });
const flat = (n: number, px = 50) => Array.from({ length: n }, (_, k) => bar(`d${String(k).padStart(4, "0")}`, px, px + 0.5, px - 0.5, px));

test("rolling extremes and RSI", () => {
  assert.deepEqual(rollingExtreme([1, 3, 2, 5, 4], 2, "max"), [null, 3, 3, 5, 5]);
  assert.deepEqual(rollingExtreme([4, 3, 5, 1, 2], 3, "min"), [null, null, 3, 1, 1]);
  const r = rsiSeries([10, 11, 12, 11, 10, 9], 2);
  assert.equal(r[2], 100);
  assert.equal(r[5], 12.5); // Wilder smoothing: gains 0.125, losses 0.875
});

test("stop entry fills on a rise and exits at the target", () => {
  const b = [...flat(5), bar("x1", 50, 51.2, 49.9, 51), bar("x2", 51, 53.5, 50.8, 53.4)];
  const p: Plan = { entryType: "stop", entry: 51, stop: 49, targetR: 1, timeStopDays: 10, exitOnStrongClose: false, score: 1, why: "" };
  const o = runPlan(b, 4, p, true, 0);
  assert.equal(o.status, "closed");
  if (o.status === "closed") { assert.equal(o.reason, "target"); assert.ok(Math.abs(o.r - 1) < 1e-9); }
});

test("open entry with a strong-close exit sells at the next open", () => {
  const b = [...flat(5), bar("a", 49, 49.5, 48, 48.5), bar("b", 48.6, 50, 48.4, 49.9), bar("c", 50.2, 50.5, 50, 50.3)];
  const p: Plan = { entryType: "open", entry: 48.5, stop: 46, targetR: null, timeStopDays: 7, exitOnStrongClose: true, score: 1, why: "" };
  const o = runPlan(b, 5, p, true, 0);
  assert.equal(o.status, "closed");
  if (o.status === "closed") { assert.equal(o.reason, "strong"); assert.equal(o.exit, 50.2); }
});

test("forward mode leaves a live trade open", () => {
  const b = [...flat(5), bar("a", 50, 50.6, 49.8, 50.4)];
  const p: Plan = { entryType: "stop", entry: 50.55, stop: 49, targetR: 2, timeStopDays: 10, exitOnStrongClose: false, score: 1, why: "" };
  assert.equal(runPlan(b, 4, p, false, 0).status, "open");
});

test("evidence is measured per day and the luck bar rises with more setups", () => {
  const same = [{ entryDate: "a", r: 1 }, { entryDate: "a", r: 1 }, { entryDate: "b", r: -1 }, { entryDate: "c", r: 0.5 }];
  assert.equal(dailyT(same).days, 3);
  assert.ok(luckBarT(8) > luckBarT(1));
  assert.ok(Math.abs(luckBarT(8) - 2.5) < 0.01);
  const good = summarizeR(new Array(200).fill(0.3));
  assert.equal(judge(good, 4, good, good, 8).pass, true);
  assert.equal(judge(good, 1, good, good, 8).pass, false);
});

test("every setup runs over a long random series without errors", () => {
  let seed = 9; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let p = 50;
  const b = Array.from({ length: 800 }, (_, k) => { const o = p; p = Math.max(5, p * (1 + 0.0004 + 0.02 * (rnd() * 2 - 1))); const v = 1e6 * (0.5 + rnd() * 2.5); return bar(`2020-${String(k).padStart(4, "0")}`, o, Math.max(o, p) * (1 + rnd() * 0.01), Math.min(o, p) * (1 - rnd() * 0.01), p, v); });
  const d = prepare(b);
  const ctx = marketCtx(b);
  for (const s of SETUPS) {
    const { trades, funnel } = backtestSymbol(s, "X", d, ctx, { minPrice: 5, maxPrice: 500 });
    assert.ok(trades.every((t) => Number.isFinite(t.r) && t.exitDate >= t.entryDate), s.id);
    assert.ok(funnel.entered === trades.length, s.id);
  }
});
