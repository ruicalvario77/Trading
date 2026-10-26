import test from "node:test";
import assert from "node:assert/strict";
import { reconcileTrade, reconcileExitOrder, weekStartUtc, limitBlock, entryLimitFor } from "./trades";
import type { Trade } from "./db/schema";

const base: Trade = {
  id: 1, candidateId: 1, symbol: "U", setup: "pullback", status: "pending_entry",
  plannedEntry: 41.77, plannedStop: 39.09, plannedTarget: 47.13, shares: 2, riskUsd: 5.36, currentStop: 39.09,
  breakevenMoved: false, brokerOrderId: "abc", exitOrderId: null, entryFill: null, enteredAt: null, exitFill: null, exitedAt: null,
  exitReason: null, pnlUsd: null, rMultiple: null, createdAt: new Date(), updatedAt: new Date(),
};
const leg = (type: string, status: string, px: string | null = null) => ({ id: type, type, status, filled_avg_price: px, filled_at: px ? "2026-10-28T15:00:00Z" : null });

test("entry limit sits a little above the trigger", () => {
  assert.equal(entryLimitFor(41.77), 41.9);
  assert.equal(entryLimitFor(10), 10.05);
});

test("pending entry with no fill changes nothing", () => {
  assert.equal(reconcileTrade(base, { ...leg("stop_limit", "new"), legs: [leg("limit", "held"), leg("stop", "held")] }), null);
});

test("filled entry opens the trade", () => {
  const u = reconcileTrade(base, { ...leg("stop_limit", "filled", "41.80"), legs: [leg("limit", "new"), leg("stop", "new")] });
  assert.equal(u?.status, "open");
  assert.equal(u?.entryFill, 41.8);
});

test("cancelled entry cancels the trade", () => {
  assert.deepEqual(reconcileTrade(base, { ...leg("stop_limit", "canceled"), legs: [] }), { status: "cancelled" });
});

test("entry and target fill between syncs closes at about +2R", () => {
  const u = reconcileTrade(base, { ...leg("stop_limit", "filled", "41.77"), legs: [leg("limit", "filled", "47.13"), leg("stop", "canceled")] });
  assert.equal(u?.status, "closed");
  assert.equal(u?.exitReason, "target");
  assert.equal(u?.pnlUsd, 10.72);
  assert.equal(u?.rMultiple, 2);
});

test("stop fill on an open trade closes at -1R", () => {
  const open = { ...base, status: "open", entryFill: 41.77 };
  const u = reconcileTrade(open, { ...leg("stop_limit", "filled", "41.77"), legs: [leg("limit", "canceled"), leg("stop", "filled", "39.09")] });
  assert.equal(u?.exitReason, "stop");
  assert.equal(u?.rMultiple, -1);
  assert.equal(u?.pnlUsd, -5.36);
});

test("week starts on Monday UTC", () => {
  assert.equal(weekStartUtc(new Date("2026-10-28T10:00:00Z")).toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(weekStartUtc(new Date("2026-11-01T23:00:00Z")).toISOString(), "2026-10-26T00:00:00.000Z");
});

test("limits block at max positions and at the weekly loss limit", () => {
  const ok = { committed: 2, maxPositions: 5, weekPnlUsd: -10, accountUsd: 550, weeklyLossLimitPct: 4 };
  assert.equal(limitBlock(ok), null);
  assert.match(limitBlock({ ...ok, committed: 5 }) ?? "", /position limit/);
  assert.match(limitBlock({ ...ok, weekPnlUsd: -22 }) ?? "", /weekly loss limit/);
});

test("time-stop sell fill closes the trade", () => {
  const open = { ...base, status: "open", entryFill: 41.77, exitOrderId: "sell1" };
  const u = reconcileExitOrder(open, leg("market", "filled", "42.50"));
  assert.equal(u?.status, "closed");
  assert.equal(u?.exitReason, "time");
  assert.equal(u?.pnlUsd, 1.46);
});

test("rejected time-stop sell is cleared for a retry", () => {
  const open = { ...base, status: "open", entryFill: 41.77, exitOrderId: "sell1" };
  assert.deepEqual(reconcileExitOrder(open, leg("market", "rejected")), { exitOrderId: null });
  assert.equal(reconcileExitOrder(open, leg("market", "new")), null);
});
