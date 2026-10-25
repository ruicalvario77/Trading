import { round2 } from "./indicators";

export type PlanInputs = {
  close: number;
  todayHigh: number;
  pullbackLow: number;
  atr14: number;
  avgVolume20: number;
};

export type PlanRules = {
  accountUsd: number;
  riskPct: number;
  maxPositionPct: number;
  minPrice: number;
  maxPrice: number;
  minAvgVolume: number;
  targetR: number;
};

export type TradePlan = {
  entry: number;
  stop: number;
  target: number;
  riskPerShare: number;
  shares: number;
  riskUsd: number;
  positionUsd: number;
  tradeable: boolean;
  reasons: string[];
};

export const DEFAULT_RULES: PlanRules = {
  accountUsd: 550,
  riskPct: 1,
  maxPositionPct: 50,
  minPrice: 5,
  maxPrice: 60,
  minAvgVolume: 1_000_000,
  targetR: 2,
};

/**
 * Turns a setup into four numbers. The stop is placed where the setup is proven wrong, then the share
 * count is sized to that stop. Position size is an output, never an input.
 */
export function planTrade(x: PlanInputs, r: PlanRules): TradePlan {
  const reasons: string[] = [];

  const entryBuffer = Math.max(0.05, round2(x.close * 0.002));
  const stopBuffer = Math.max(0.05, round2(x.atr14 * 0.25));
  const entry = round2(x.todayHigh + entryBuffer);
  const stop = round2(x.pullbackLow - stopBuffer);
  const riskPerShare = round2(entry - stop);
  const target = round2(entry + r.targetR * riskPerShare);

  if (x.close < r.minPrice) reasons.push(`price ${x.close.toFixed(2)} below minimum ${r.minPrice}`);
  if (x.close > r.maxPrice) reasons.push(`price ${x.close.toFixed(2)} above maximum ${r.maxPrice}`);
  if (x.avgVolume20 < r.minAvgVolume) reasons.push(`average volume ${Math.round(x.avgVolume20).toLocaleString()} below ${r.minAvgVolume.toLocaleString()}`);

  const stopPct = riskPerShare / entry;
  if (riskPerShare <= 0) reasons.push("stop is not below entry");
  else if (stopPct > 0.08) reasons.push(`stop ${(stopPct * 100).toFixed(1)}% away, wider than 8%`);
  else if (stopPct < 0.01) reasons.push(`stop ${(stopPct * 100).toFixed(1)}% away, tighter than 1%`);

  const riskBudget = (r.accountUsd * r.riskPct) / 100;
  const shares = riskPerShare > 0 ? Math.floor(riskBudget / riskPerShare) : 0;
  const riskUsd = round2(shares * riskPerShare);
  const positionUsd = round2(shares * entry);

  if (shares < 1) reasons.push(`risk budget $${riskBudget.toFixed(2)} buys 0 shares at $${riskPerShare.toFixed(2)} risk per share`);
  if (positionUsd > (r.accountUsd * r.maxPositionPct) / 100)
    reasons.push(`position $${positionUsd.toFixed(0)} exceeds ${r.maxPositionPct}% of account`);

  return { entry, stop, target, riskPerShare, shares, riskUsd, positionUsd, tradeable: reasons.length === 0, reasons };
}
