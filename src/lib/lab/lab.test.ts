import test from "node:test";
import assert from "node:assert/strict";
import { windowMetrics, markToMarket, type CurvePoint } from "./metrics";
import { simulateRotation, simulateMeanReversion } from "./strategies";
import type { OHLCV } from "../indicators";

const cal = (n: number) => {
  const out: string[] = [];
  for (let k = 0; out.length < n; k++) { const d = new Date(Date.UTC(2018, 0, 1) + k * 864e5); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); }
  return out;
};
const series = (dates: string[], f: (k: number) => number): OHLCV[] =>
  dates.map((date, k) => ({ date, open: f(k), high: f(k) * 1.005, low: f(k) * 0.995, close: f(k), volume: 1e6 }));

test("window metrics: return, drawdown and exposure", () => {
  const c: CurvePoint[] = [100, 110, 99, 121].map((e, k) => ({ date: `2020-01-0${k + 1}`, equity: e, invested: e / 2 }));
  const m = windowMetrics(c, [], "2020-01-01", "2020-12-31");
  assert.ok(Math.abs(m.totalReturnPct - 21) < 1e-9);
  assert.ok(Math.abs(m.maxDrawdownPct - 10) < 1e-9);
  assert.ok(Math.abs(m.exposurePct - 50) < 1e-9);
});

test("mark to market values open positions at the close", () => {
  const closes = new Map([["A", new Map([["d1", 10], ["d2", 12], ["d3", 11]])]]);
  const c = markToMarket([{ symbol: "A", entryDate: "d1", exitDate: "d3", entry: 10, shares: 10, pnl: 15 }], ["d1", "d2", "d3"], closes, 1000);
  assert.deepEqual(c.map((p) => p.equity), [1000, 1020, 1015]);
  assert.equal(c[2].invested, 0);
});

test("rotation holds the strongest uptrending ETF and avoids the falling one", () => {
  const dates = cal(400);
  const bars = new Map([
    ["UP", series(dates, (k) => 50 * Math.pow(1.002, k))],
    ["DOWN", series(dates, (k) => 50 * Math.pow(0.999, k))],
  ]);
  const { curve, trades } = simulateRotation(bars, dates, ["UP", "DOWN"], 100_000, 1);
  const end = curve[curve.length - 1];
  assert.ok(end.equity > 100_000, `equity ${end.equity}`);
  assert.ok(end.invested > 0.9 * end.equity);
  assert.ok(trades.every((t) => t.symbol === "UP"));
});

test("dip buying enters after three down closes and exits on a strong close", () => {
  const dates = cal(260);
  const px = (k: number) => (k < 250 ? 100 + k * 0.2 : [149, 148, 147, 146.9, 150, 151, 152, 153, 154, 155][k - 250]);
  const bars = new Map([["SPY", series(dates, px)]]);
  const { trades } = simulateMeanReversion(bars, dates, ["SPY"], 100_000);
  assert.equal(trades.length, 1);
  assert.ok(trades[0].ret > 0, `ret ${trades[0].ret}`);
});
