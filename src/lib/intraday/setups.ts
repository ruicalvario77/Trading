import { OPEN_M, OR_END_M, type Session, type SBar } from "./session";

/** Cost per side for the most liquid US stocks: spread and slippage on market and stop orders. */
export const INTRADAY_SLIPPAGE_PCT = 0.05;

export type ITrade = {
  setup: string;
  symbol: string;
  date: string;
  entryM: number;
  exitM: number;
  entry: number;
  exit: number;
  stop: number;
  r: number;
  reason: "stop" | "target" | "close";
};

export type IntradaySetup = {
  id: string;
  version: string;
  name: string;
  summary: string;
  rules: string[];
  run: (s: Session) => ITrade | null;
};

/**
 * Follows a long trade inside one session from bar k. For a stop entry the price is reached during bar k, so on
 * that bar only the stop is checked: it cannot be known that the target came after the entry. For an entry at
 * the open of bar k, both are checked, stop first. Anything still open is sold at the session's last close.
 */
export function followLong(
  s: Session, setup: string, k: number, entry: number, stop: number, target: number | null, entryAtOpen: boolean,
  slipPct = INTRADAY_SLIPPAGE_PCT,
): ITrade {
  const slip = slipPct / 100;
  const b = s.bars;
  const fill = entry * (1 + slip);
  const risk = fill - stop;
  const done = (j: number, px: number, reason: ITrade["reason"]): ITrade => {
    const exit = px * (1 - slip);
    return { setup, symbol: s.symbol, date: s.date, entryM: b[k].m, exitM: b[j].m, entry: fill, exit, stop, r: (exit - fill) / risk, reason };
  };
  for (let j = k; j < b.length; j++) {
    const bar = b[j];
    if (j > k) {
      if (bar.o <= stop) return done(j, bar.o, "stop");
      if (target !== null && bar.o >= target) return done(j, bar.o, "target");
    }
    if (bar.l <= stop) return done(j, stop, "stop");
    if (target !== null && bar.h >= target && (j > k || entryAtOpen)) return done(j, target, "target");
  }
  return done(b.length - 1, b[b.length - 1].c, "close");
}

const vwapSeries = (b: SBar[]) => {
  let pv = 0;
  let v = 0;
  return b.map((x) => { pv += ((x.h + x.l + x.c) / 3) * x.v; v += x.v; return v > 0 ? pv / v : x.c; });
};

export const INTRADAY_SETUPS: IntradaySetup[] = [
  {
    id: "orb30", version: "v1", name: "Opening range breakout, stocks in play",
    summary: "A stock trading twice its normal volume in the first half hour breaks above that half hour's high.",
    rules: [
      "Opening range: the high and low from 09:30 to 10:00 New York time.",
      "Only when volume in that half hour is at least twice the stock's average for the same half hour over the last 20 days.",
      "Buy on the first rise above the range high between 10:00 and 11:30. Stop at the range low (between 0.2% and 3% away).",
      "Target 2R. Anything still open is sold at the close. One trade per stock per day.",
    ],
    run: (s) => {
      const b = s.bars;
      if (!s.orVolAvg || b[0]?.m !== OPEN_M) return null;
      const or = b.filter((x) => x.m < OR_END_M);
      if (or.length < 6) return null;
      const hi = Math.max(...or.map((x) => x.h));
      const lo = Math.min(...or.map((x) => x.l));
      const vol = or.reduce((a, x) => a + x.v, 0);
      if (vol < 2 * s.orVolAvg) return null;
      for (let k = or.length; k < b.length && b[k].m < 11 * 60 + 30; k++) {
        if (b[k].h <= hi) continue;
        const entry = Math.max(hi + 0.01, b[k].o);
        const risk = (entry - lo) / entry;
        if (risk < 0.002 || risk > 0.03) return null;
        return followLong(s, "orb30", k, entry, lo, entry + 2 * (entry - lo), false);
      }
      return null;
    },
  },
  {
    id: "gap-go", version: "v1", name: "Gap and go",
    summary: "A stock that opens 3% above yesterday's close and holds in the first five minutes, bought as it breaks higher.",
    rules: [
      "Opens at least 3% above the previous day's close.",
      "The first five-minute bar closes above its open.",
      "Buy on the first rise above that bar's high before 10:30. Stop at that bar's low (between 0.2% and 4% away).",
      "Target 2R. Anything still open is sold at the close.",
    ],
    run: (s) => {
      const b = s.bars;
      const f = b[0];
      if (!f || f.m !== OPEN_M || !s.prevClose || f.o < s.prevClose * 1.03 || !(f.c > f.o)) return null;
      for (let k = 1; k < b.length && b[k].m < 10 * 60 + 30; k++) {
        if (b[k].h <= f.h) continue;
        const entry = Math.max(f.h + 0.01, b[k].o);
        const risk = (entry - f.l) / entry;
        if (risk < 0.002 || risk > 0.04) return null;
        return followLong(s, "gap-go", k, entry, f.l, entry + 2 * (entry - f.l), false);
      }
      return null;
    },
  },
  {
    id: "vwap-stretch", version: "v1", name: "Stretch below VWAP",
    summary: "Mean reversion: a liquid stock that falls 1.5% below the day's volume-weighted average price, bought for the snap back.",
    rules: [
      "Between 10:30 and 14:30, a five-minute bar closes at least 1.5% below the day's VWAP (average price weighted by volume).",
      "Buy at the next bar's open. Target: the VWAP at the signal. Stop 1% below the entry.",
      "Anything still open is sold at the close. One trade per stock per day.",
    ],
    run: (s) => {
      const b = s.bars;
      const vw = vwapSeries(b);
      for (let k = 0; k < b.length - 2; k++) {
        if (b[k].m < 10 * 60 + 30 || b[k].m >= 14 * 60 + 30) continue;
        if (b[k].c > vw[k] * 0.985) continue;
        const entry = b[k + 1].o;
        const target = vw[k];
        if (entry >= target) return null;
        return followLong(s, "vwap-stretch", k + 1, entry, entry * 0.99, target, true);
      }
      return null;
    },
  },
];

export function intradaySetupById(id: string) {
  return INTRADAY_SETUPS.find((s) => s.id === id);
}
