import test from "node:test";
import assert from "node:assert/strict";
import { buildMarket, isMonthEnd } from "./market";
import { simulateWeights } from "./sim";
import { CONFIGS, BASELINE_ID } from "./families";
import { runAll, selectChampion, metaTest, firstDecisionDay, requiredMargin, normInv } from "./research";
import type { OHLCV } from "../indicators";

const days = (n: number) => {
  const out: string[] = [];
  for (let k = 0; out.length < n; k++) { const d = new Date(Date.UTC(2016, 0, 4) + k * 864e5); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); }
  return out;
};
const series = (dates: string[], f: (k: number) => number): OHLCV[] => dates.map((date, k) => ({ date, open: f(k), high: f(k) * 1.004, low: f(k) * 0.996, close: f(k), volume: 1e6 }));

test("month end, including the newest day", () => {
  assert.equal(isMonthEnd(["2026-10-29", "2026-10-30", "2026-11-02"], 1), true);
  assert.equal(isMonthEnd(["2026-10-29", "2026-10-30", "2026-11-02"], 0), false);
  assert.equal(isMonthEnd(["2026-10-30"], 0), true); // Friday 30 Oct, next weekday is 2 Nov
  assert.equal(isMonthEnd(["2026-10-29"], 0), false);
});

test("holding SPY tracks SPY minus the entry cost", () => {
  const d = days(300);
  const m = buildMarket(new Map([["SPY", series(d, (k) => 100 * Math.pow(1.001, k))]]));
  const r = simulateWeights(m, () => ({ SPY: 1 }), 100_000);
  const growth = r.curve[r.curve.length - 1].equity / 100_000;
  const spy = Math.pow(1.001, 299) / Math.pow(1.001, 1); // bought at day 1's open
  assert.ok(Math.abs(growth - spy) < 0.01, `${growth} vs ${spy}`);
  assert.equal(r.rebalances, 1);
});

test("timing moves to cash below the average and back above it", () => {
  const d = days(400);
  const px = (k: number) => (k < 250 ? 100 + k * 0.1 : k < 320 ? 125 - (k - 250) * 0.5 : 90 + (k - 320) * 0.8);
  const m = buildMarket(new Map([["SPY", series(d, px)]]));
  const def = CONFIGS.find((c) => c.id === "timing:SPY:100:cash:daily")!;
  const r = simulateWeights(m, def.make(m), 100_000);
  assert.ok(r.rebalances >= 3, `rebalances ${r.rebalances}`);
  const mid = r.curve[310];
  assert.ok(mid.invested < 1, "in cash during the fall");
  assert.ok(r.curve[r.curve.length - 1].invested > 0, "back in at the end");
});

test("the index stays champion unless a challenger clearly beats it", () => {
  const d = days(1300);
  const spy = series(d, (k) => 100 * Math.pow(1.0004, k) * (1 + 0.02 * Math.sin(k / 7)));
  const bars = new Map([["SPY", spy], ["QQQ", spy], ["VTI", spy], ["TLT", series(d, () => 100)], ["EFA", spy], ["IWM", spy], ["DIA", spy]]);
  const m = buildMarket(bars);
  const runs = runAll(m, 100_000, CONFIGS.filter((c) => c.family === "hold"));
  const sel = selectChampion(runs, d.length - 1, null);
  assert.equal(sel.id, BASELINE_ID);
  const mt = metaTest(runs, m);
  assert.equal(mt.switches, 0);
  assert.ok(Math.abs(mt.loop.cagrPct - mt.index.cagrPct) < 0.5);
  assert.ok(firstDecisionDay() < d.length);
});

test("the luck bar grows with the number of rule sets and shrinks with more data", () => {
  assert.ok(Math.abs(normInv(0.975) - 1.959964) < 1e-5);
  assert.ok(Math.abs(normInv(0.5)) < 1e-9);
  const m57 = requiredMargin(57, 3);
  assert.ok(m57 > 1.2 && m57 < 1.5, `57 rule sets over 3 years: ${m57}`);
  assert.ok(requiredMargin(57, 12) < m57);
  assert.ok(requiredMargin(5, 3) < m57);
  assert.equal(requiredMargin(1, 3), 0);
});
