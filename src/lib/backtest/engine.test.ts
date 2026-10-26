import test from "node:test";
import assert from "node:assert/strict";
import { simulateSymbol, runPortfolio, type SimConfig, type SimTrade } from "./engine";
import { DEFAULT_RULES } from "../planner";
import { MIN_HISTORY } from "../strategy/pullback";
import { summarizeR } from "../stats";
import type { OHLCV } from "../indicators";

const bars = (closes: number[]): OHLCV[] =>
  closes.map((c, i) => ({ date: `2020-${String(Math.floor(i / 28) + 1).padStart(3, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, open: c, high: c + 0.3, low: c - 0.3, close: c, volume: 2_000_000 }));

function setupThen(after: number[]): OHLCV[] {
  const closes: number[] = [];
  for (let i = 0; i < MIN_HISTORY + 10; i++) closes.push(20 + i * 0.1);
  const last = closes[closes.length - 1];
  closes.push(last - 0.6, last - 1.2, last - 1.8, last - 2.2, last - 1.6); // pullback, then an up close
  return bars([...closes, ...after]);
}

const cfg: SimConfig = { rules: DEFAULT_RULES, timeStopDays: 10, slippagePct: 0.1, entryWindowDays: 2 };

test("a pullback that rallies hits the 2R target", () => {
  const { trades, funnel } = simulateSymbol("X", setupThen([40.8, 41.5, 42.5, 43.5, 44.5]), "fixed", cfg);
  assert.equal(funnel.entered, 1);
  assert.equal(trades[0].exitReason, "target");
  assert.ok(trades[0].r > 1.5 && trades[0].r < 2, `r=${trades[0].r}`);
});

test("a pullback that fails hits the stop at about -1R", () => {
  const { trades } = simulateSymbol("X", setupThen([40.8, 39.6, 39.4, 39]), "fixed", cfg);
  assert.equal(trades[0].exitReason, "stop");
  assert.ok(trades[0].r < -0.9 && trades[0].r > -1.2, `r=${trades[0].r}`);
});

test("a setup that never triggers does not trade", () => {
  // Entry is $40.68; highs stay below it.
  const { trades, funnel } = simulateSymbol("X", setupThen([40.2, 40.1, 40.3]), "fixed", cfg);
  assert.equal(trades.length, 0);
  assert.ok(funnel.unfilled >= 1);
});

test("a trade going nowhere exits on the time stop", () => {
  const flat = new Array(14).fill(41.0);
  const { trades } = simulateSymbol("X", setupThen([40.8, ...flat]), "fixed", cfg);
  assert.equal(trades[0].exitReason, "time");
  assert.equal(trades[0].daysHeld, 11);
});

test("breakeven variant scratches a trade that reached +1R then reversed", () => {
  // Entry $40.68, stop $39.23, so +1R is $42.13. Close above it, then gap back under entry.
  const { trades } = simulateSymbol("X", setupThen([40.8, 42.3, 40.6, 39.9]), "breakeven", cfg);
  assert.equal(trades[0].exitReason, "breakeven");
  assert.ok(Math.abs(trades[0].r) < 0.2, `r=${trades[0].r}`);
});

const t = (sym: string, entryDate: string, exitDate: string, r: number): SimTrade => ({
  symbol: sym, signalDate: entryDate, entryDate, exitDate, entry: 50, exit: 50 + r * 2, riskPerShare: 2, r, exitReason: r > 0 ? "target" : "stop", score: 1, daysHeld: 3,
});

test("portfolio sizes by risk and respects the position limit", () => {
  const res = runPortfolio(
    [t("A", "2020-01-06", "2020-01-10", 2), t("B", "2020-01-06", "2020-01-10", -1), t("C", "2020-01-07", "2020-01-09", 2)],
    { startEquity: 10_000, riskPct: 1, maxPositionPct: 100, maxPositions: 2, weeklyLossLimitPct: 50 },
    "2020-01-01", "2020-12-31",
  );
  assert.equal(res.taken, 2);
  assert.equal(res.skipped.maxPositions, 1);
  // 50 shares each ($100 risk / $2): +$200 and -$100.
  assert.equal(Math.round(res.finalEquity), 10_100);
});

test("R statistics", () => {
  const s = summarizeR([2, -1, -1, 2, -1, -1, -1]);
  assert.equal(s.trades, 7);
  assert.equal(s.maxLosingStreak, 3);
  assert.ok(Math.abs(s.expectancyR - -1 / 7) < 1e-9);
  assert.equal(s.profitFactor, 4 / 5);
});
