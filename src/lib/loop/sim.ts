import type { CurvePoint } from "../lab/metrics";
import { type Market, type Weights, sameWeights } from "./market";
import type { Stepper } from "./families";

export type SimResult = { curve: CurvePoint[]; rets: number[]; rebalances: number; lastTarget: Weights };

/**
 * Follows a rule set day by day. Decisions use the close; trades happen at the next open in whole shares,
 * sells before buys, with `slipPct` cost on each side. Holdings are only traded when the target changes.
 */
export function simulateWeights(m: Market, step: Stepper, startEquity: number, slipPct = 0.1): SimResult {
  const slip = slipPct / 100;
  let cash = startEquity;
  const shares = new Map<string, number>();
  const last = new Map<string, number>();
  let target: Weights = {};
  let pending: Weights | null = null;
  let rebalances = 0;
  const curve: CurvePoint[] = [];
  const rets: number[] = [];

  for (let t = 0; t < m.calendar.length; t++) {
    const d = m.calendar[t];
    if (pending) {
      const syms = new Set([...Object.keys(pending), ...shares.keys()]);
      const open = new Map<string, number>();
      let ready = true;
      for (const s of syms) {
        const k = m.S.get(s)?.idx.get(d);
        if (k === undefined) { ready = false; break; }
        open.set(s, m.S.get(s)!.bars[k].open);
      }
      if (ready) {
        let equity = cash;
        for (const [s, q] of shares) equity += q * open.get(s)!;
        const want = new Map<string, number>();
        for (const s of syms) want.set(s, Math.floor(((pending[s] ?? 0) * equity) / open.get(s)!));
        for (const [s, q] of [...shares]) {
          const diff = q - (want.get(s) ?? 0);
          if (diff > 0) {
            cash += diff * open.get(s)! * (1 - slip);
            if (q - diff > 0) shares.set(s, q - diff); else shares.delete(s);
          }
        }
        for (const [s, w] of want) {
          const diff = w - (shares.get(s) ?? 0);
          if (diff <= 0) continue;
          const px = open.get(s)! * (1 + slip);
          const q = Math.min(diff, Math.floor(cash / px));
          if (q > 0) { cash -= q * px; shares.set(s, (shares.get(s) ?? 0) + q); }
        }
        pending = null;
        rebalances++;
      }
    }

    for (const s of shares.keys()) {
      const k = m.S.get(s)?.idx.get(d);
      if (k !== undefined) last.set(s, m.S.get(s)!.bars[k].close);
    }
    let invested = 0;
    for (const [s, q] of shares) invested += q * (last.get(s) ?? 0);
    const equity = cash + invested;
    rets.push(curve.length ? equity / curve[curve.length - 1].equity - 1 : 0);
    curve.push({ date: d, equity, invested });

    const w = step(t);
    if (w && !sameWeights(w, target)) { target = w; pending = w; }
  }
  return { curve, rets, rebalances, lastTarget: target };
}
