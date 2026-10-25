import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePullback, MIN_HISTORY } from "./pullback";
import type { OHLCV } from "../indicators";

function series(closes: number[]): OHLCV[] {
  return closes.map((c, i) => ({
    date: `d${i}`,
    open: c,
    high: c + 0.3,
    low: c - 0.3,
    close: c,
    volume: 2_000_000,
  }));
}

test("rejects when history is too short", () => {
  const r = evaluatePullback(series(new Array(50).fill(10)));
  assert.equal(r.ok, false);
});

test("detects an uptrend pullback that is turning up", () => {
  // 220 bars rising gently, then a 4-day dip to the 20-day EMA, then an up close.
  const closes: number[] = [];
  for (let i = 0; i < MIN_HISTORY + 10; i++) closes.push(20 + i * 0.1);
  const last = closes[closes.length - 1];
  closes.push(last - 0.6, last - 1.2, last - 1.8, last - 2.2, last - 1.6);
  const r = evaluatePullback(series(closes));
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) {
    assert.ok(r.sma50 > r.sma200);
    assert.ok(r.close > r.sma200);
    assert.ok(r.score > 0);
  }
});

test("rejects a downtrend", () => {
  const closes: number[] = [];
  for (let i = 0; i < MIN_HISTORY + 20; i++) closes.push(60 - i * 0.1);
  closes.push(closes[closes.length - 1] + 0.5);
  const r = evaluatePullback(series(closes));
  assert.equal(r.ok, false);
});
