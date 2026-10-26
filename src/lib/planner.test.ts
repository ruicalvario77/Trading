import test from "node:test";
import assert from "node:assert/strict";
import { planTrade, DEFAULT_RULES } from "./planner";

test("worked example from the lifecycle page sizes to the stop", () => {
  const plan = planTrade(
    { close: 50.4, todayHigh: 50.4, pullbackLow: 48.9, atr14: 1.6, avgVolume20: 2_000_000 },
    { ...DEFAULT_RULES, accountUsd: 10_000, riskPct: 1, maxPrice: 100, maxPositionPct: 50 },
  );
  assert.equal(plan.entry, 50.5);
  assert.equal(plan.stop, 48.5);
  assert.equal(plan.target, 54.5);
  assert.equal(plan.shares, 50);
  assert.equal(plan.riskUsd, 100);
  assert.equal(plan.tradeable, true);
});

test("a R10,000 account (about $550) cannot take a $50 stock with a $2 stop", () => {
  const plan = planTrade(
    { close: 50.4, todayHigh: 50.4, pullbackLow: 48.9, atr14: 1.6, avgVolume20: 2_000_000 },
    { ...DEFAULT_RULES, accountUsd: 550, riskPct: 1, maxPrice: 100, maxPositionPct: 50 },
  );
  assert.equal(plan.shares, 2);
  assert.equal(plan.tradeable, true);
  assert.equal(plan.riskUsd, 4);
});

test("stops wider than 8% are rejected", () => {
  const plan = planTrade(
    { close: 20, todayHigh: 20, pullbackLow: 17.5, atr14: 1, avgVolume20: 2_000_000 },
    DEFAULT_RULES,
  );
  assert.equal(plan.tradeable, false);
  assert.ok(plan.reasons.some((r) => r.includes("wider than 8%")));
});

test("illiquid or out-of-band prices are rejected", () => {
  const plan = planTrade(
    { close: 80, todayHigh: 80, pullbackLow: 78, atr14: 1, avgVolume20: 10_000 },
    { ...DEFAULT_RULES, maxPrice: 60 },
  );
  assert.equal(plan.tradeable, false);
  assert.equal(plan.reasons.length, 2);
});

test("a tight stop is trimmed to the position cap instead of rejected", () => {
  // R100,000 account: $55.56 risk budget, 20% cap = $1,111. A $0.50 stop on a $50 stock wants 111 shares.
  const plan = planTrade(
    { close: 50, todayHigh: 50, pullbackLow: 49.6, atr14: 0.4, avgVolume20: 2_000_000 },
    DEFAULT_RULES,
  );
  assert.equal(plan.tradeable, true);
  assert.equal(plan.shares, Math.floor(1111.2 / plan.entry));
  assert.ok(plan.positionUsd <= 1111.2);
});
