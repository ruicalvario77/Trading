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
  accountUsd: 5556, // R100,000 at 18 rand per dollar
  riskPct: 1,
  maxPositionPct: 20, // five positions at 20% each uses the whole account, no margin
  minPrice: 5,
  maxPrice: 500,
  // Measured on the free IEX feed, which carries roughly 2-3% of US volume.
  // 25,000 IEX shares a day is about 1 million shares across all exchanges.
  minAvgVolume: 25_000,
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
  if (x.avgVolume20 < r.minAvgVolume) reasons.push(`average IEX volume ${Math.round(x.avgVolume20).toLocaleString()} below ${r.minAvgVolume.toLocaleString()}`);

  const stopPct = riskPerShare / entry;
  if (riskPerShare <= 0) reasons.push("stop is not below entry");
  else if (stopPct > 0.08) reasons.push(`stop ${(stopPct * 100).toFixed(1)}% away, wider than 8%`);
  else if (stopPct < 0.01) reasons.push(`stop ${(stopPct * 100).toFixed(1)}% away, tighter than 1%`);

  const riskBudget = (r.accountUsd * r.riskPct) / 100;
  // Size to the stop, then trim to the position cap. A tight stop can mean fewer shares than the risk budget allows.
  const riskShares = riskPerShare > 0 ? Math.floor(riskBudget / riskPerShare) : 0;
  const capShares = Math.floor((r.accountUsd * r.maxPositionPct) / 100 / entry);
  const shares = Math.max(0, Math.min(riskShares, capShares));
  const riskUsd = round2(shares * riskPerShare);
  const positionUsd = round2(shares * entry);

  if (shares < 1)
    reasons.push(
      riskShares < 1
        ? `risk budget $${riskBudget.toFixed(2)} buys 0 shares at $${riskPerShare.toFixed(2)} risk per share`
        : `one share costs more than the ${r.maxPositionPct}% position cap`,
    );

  return { entry, stop, target, riskPerShare, shares, riskUsd, positionUsd, tradeable: reasons.length === 0, reasons };
}
