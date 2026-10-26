import { UNIVERSE } from "../universe";
import { type Market, type Weights, barIndex, isMonthEnd, smaOf } from "./market";

/**
 * The loop's menu. Each rule set turns market data up to a day's close into target holdings
 * (symbol -> fraction of the account). Returning null means "no change". The loop never invents
 * new rule types; it measures which of these has been working and paper trades that one.
 */
export type Stepper = (t: number) => Weights | null;
export type ConfigDef = { id: string; family: Family; label: string; make: (m: Market) => Stepper };
export type Family = "hold" | "timing" | "rotation" | "dualmom" | "meanrev";

export const FAMILY_LABEL: Record<Family, string> = {
  hold: "Buy and hold",
  timing: "Trend timing",
  rotation: "ETF rotation",
  dualmom: "Dual momentum",
  meanrev: "Dip buying",
};

export const BASELINE_ID = "hold:SPY";

const ETFS = UNIVERSE.filter((u) => u.kind === "etf").map((u) => u.symbol);
const LOOKS: Record<string, number[]> = { "3": [63], "6": [126], "12": [252], "6+12": [126, 252] };

function ret(m: Market, s: string, t: number, days: number): number | null {
  const se = m.S.get(s);
  const k = barIndex(m, s, t);
  if (!se || k === undefined || k < days) return null;
  return se.bars[k].close / se.bars[k - days].close - 1;
}

function aboveSma(m: Market, s: string, t: number, n: number): boolean | null {
  const se = m.S.get(s);
  const k = barIndex(m, s, t);
  if (!se || k === undefined) return null;
  const v = smaOf(se, n)[k];
  return v === null ? null : se.bars[k].close > v;
}

function hold(asset: string): ConfigDef {
  return { id: `hold:${asset}`, family: "hold", label: `Hold ${asset}`, make: () => () => ({ [asset]: 1 }) };
}

function timing(asset: string, n: number, off: "cash" | "TLT", check: "daily" | "monthly"): ConfigDef {
  return {
    id: `timing:${asset}:${n}:${off}:${check}`,
    family: "timing",
    label: `Hold ${asset} above its ${n}-day average, else ${off === "cash" ? "cash" : "bonds (TLT)"}, checked ${check}`,
    make: (m) => (t) => {
      if (check === "monthly" && !isMonthEnd(m.calendar, t)) return null;
      const up = aboveSma(m, asset, t, n);
      if (up === null) return null;
      return up ? { [asset]: 1 } : off === "TLT" ? { TLT: 1 } : {};
    },
  };
}

function rotation(k: number, look: string, filter: boolean): ConfigDef {
  return {
    id: `rotation:${k}:${look}:${filter ? "f" : "nf"}`,
    family: "rotation",
    label: `Top ${k} ETF${k > 1 ? "s" : ""} by ${look.replace("+", " and ")}-month change${filter ? ", only above 200-day average" : ""}, monthly`,
    make: (m) => (t) => {
      if (!isMonthEnd(m.calendar, t)) return null;
      const ranked: { s: string; score: number }[] = [];
      for (const s of ETFS) {
        const rs = LOOKS[look].map((d) => ret(m, s, t, d));
        if (rs.some((r) => r === null)) continue;
        if (filter && aboveSma(m, s, t, 200) !== true) continue;
        ranked.push({ s, score: (rs as number[]).reduce((a, b) => a + b, 0) / rs.length });
      }
      ranked.sort((a, b) => b.score - a.score);
      const w: Weights = {};
      for (const r of ranked.slice(0, k)) w[r.s] = 1 / k;
      return w;
    },
  };
}

function dualmom(months: number): ConfigDef {
  const days = months === 6 ? 126 : 252;
  return {
    id: `dualmom:${months}`,
    family: "dualmom",
    label: `US (SPY) or international (EFA), whichever rose more over ${months} months; bonds (TLT) if neither rose; monthly`,
    make: (m) => (t): Weights | null => {
      if (!isMonthEnd(m.calendar, t)) return null;
      const a = ret(m, "SPY", t, days);
      const b = ret(m, "EFA", t, days);
      if (a === null || b === null) return null;
      if (Math.max(a, b) <= 0) return { TLT: 1 };
      return a >= b ? { SPY: 1 } : { EFA: 1 };
    },
  };
}

function meanrev(down: number, exit: "strong" | "5day"): ConfigDef {
  const assets = ["SPY", "QQQ", "IWM", "DIA"];
  return {
    id: `meanrev:${down}:${exit}`,
    family: "meanrev",
    label: `Buy index ETFs above their 200-day average after ${down} lower closes; sell on ${exit === "strong" ? "the first close above the prior high" : "the 5th day"}`,
    make: (m) => {
      const held = new Map<string, number>(); // symbol -> calendar index of decision
      return (t) => {
        let changed = false;
        for (const s of assets) {
          const se = m.S.get(s);
          const k = barIndex(m, s, t);
          if (!se || k === undefined || k < down + 1) continue;
          const b = se.bars;
          const since = held.get(s);
          if (since !== undefined) {
            const days = t - since;
            if ((exit === "strong" ? b[k].close > b[k - 1].high : days >= 5) || days >= 10) { held.delete(s); changed = true; }
          } else if (aboveSma(m, s, t, 200)) {
            let falling = true;
            for (let j = 0; j < down; j++) if (!(b[k - j].close < b[k - j - 1].close)) falling = false;
            if (falling) { held.set(s, t); changed = true; }
          }
        }
        if (!changed) return null;
        const w: Weights = {};
        for (const s of held.keys()) w[s] = 0.25;
        return w;
      };
    },
  };
}

export const CONFIGS: ConfigDef[] = [
  hold("SPY"), hold("QQQ"), hold("VTI"),
  ...["SPY", "QQQ"].flatMap((a) => [100, 150, 200].flatMap((n) => (["cash", "TLT"] as const).flatMap((off) => (["daily", "monthly"] as const).map((c) => timing(a, n, off, c))))),
  ...[1, 2, 3].flatMap((k) => Object.keys(LOOKS).flatMap((look) => [true, false].map((f) => rotation(k, look, f)))),
  dualmom(6), dualmom(12),
  ...[2, 3].flatMap((d) => (["strong", "5day"] as const).map((e) => meanrev(d, e))),
];

export const LOOP_SYMBOLS = [...new Set([...ETFS, "SPY", "QQQ", "IWM", "DIA", "EFA", "TLT", "VTI"])];

export function configById(id: string): ConfigDef | undefined {
  return CONFIGS.find((c) => c.id === id);
}
