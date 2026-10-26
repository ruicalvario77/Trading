export type RStats = {
  trades: number;
  wins: number;
  winRate: number;
  avgWinR: number;
  avgLossR: number;
  expectancyR: number;
  totalR: number;
  profitFactor: number | null;
  maxLosingStreak: number;
};

/** Summary of a list of trade results in R (multiples of initial risk), in time order. */
export function summarizeR(rs: number[]): RStats {
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  let streak = 0;
  let maxLosingStreak = 0;
  for (const r of rs) {
    streak = r <= 0 ? streak + 1 : 0;
    maxLosingStreak = Math.max(maxLosingStreak, streak);
  }
  const lossSum = Math.abs(sum(losses));
  return {
    trades: rs.length,
    wins: wins.length,
    winRate: rs.length ? wins.length / rs.length : 0,
    avgWinR: wins.length ? sum(wins) / wins.length : 0,
    avgLossR: losses.length ? sum(losses) / losses.length : 0,
    expectancyR: rs.length ? sum(rs) / rs.length : 0,
    totalR: sum(rs),
    profitFactor: lossSum > 0 ? sum(wins) / lossSum : null,
    maxLosingStreak,
  };
}
