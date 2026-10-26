import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { requireDb, schema, type Db } from "../db";
import { loadSettings } from "../settings";
import { round2 } from "../indicators";
import { committedCount, weekPnl } from "../jobs/orders";
import { limitBlock } from "../trades";
import { SETUPS, type Plan } from "./library";
import { forwardStats, type ForwardStats, type SetupRunResults } from "./run";

/** Forward trades a setup needs before it can paper trade. */
export const MIN_FORWARD_TRADES = 30;

export type Stage = "research" | "failed" | "forward" | "paper";
export type SetupStatus = { id: string; version: string; stage: Stage; detail: string; backtestPass: boolean | null; forward: ForwardStats };

export async function setupStatuses(db: Db): Promise<{ statuses: SetupStatus[]; run: { id: number; results: SetupRunResults } | null }> {
  const [row] = await db.select().from(schema.setupRuns).orderBy(desc(schema.setupRuns.id)).limit(1);
  const run = row ? { id: row.id, results: row.results as SetupRunResults } : null;
  const fwd = await forwardStats(db);
  const statuses = SETUPS.map((s): SetupStatus => {
    const bt = run?.results.setups.find((x) => x.id === s.id && x.version === s.version);
    const forward = fwd.find((f) => f.id === s.id)!;
    const n = forward.closed.trades;
    if (!bt) return { id: s.id, version: s.version, stage: "research", detail: "Not backtested yet.", backtestPass: null, forward };
    if (!bt.verdict.pass) {
      return { id: s.id, version: s.version, stage: "failed", detail: `Backtest: ${bt.verdict.reasons.join("; ")}. Still tracked forward, in case it is wrong.`, backtestPass: false, forward };
    }
    if (n < MIN_FORWARD_TRADES || forward.closed.expectancyR <= 0) {
      return {
        id: s.id, version: s.version, stage: "forward", backtestPass: true, forward,
        detail: n < MIN_FORWARD_TRADES ? `Passed the backtest. ${n} of ${MIN_FORWARD_TRADES} forward trades closed.` : `Passed the backtest, but forward trades average ${forward.closed.expectancyR.toFixed(2)}R.`,
      };
    }
    return { id: s.id, version: s.version, stage: "paper", backtestPass: true, forward, detail: `Passed the backtest and ${n} forward trades average ${forward.closed.expectancyR.toFixed(2)}R. Paper trading.` };
  });
  return { statuses, run };
}

export type AutoPaperSummary = { eligible: string[]; considered: number; queued: number; blocked: string | null };

/**
 * For setups at the paper stage, turns today's signals into approved candidates, sized to the account rules.
 * The pre-open job places them. Best setups and best scores go first, up to the position limit.
 */
export async function autoPaper(): Promise<AutoPaperSummary> {
  const db = requireDb();
  const settings = await loadSettings();
  const { statuses } = await setupStatuses(db);
  const eligible = statuses.filter((s) => s.stage === "paper").sort((a, b) => b.forward.closed.expectancyR - a.forward.closed.expectancyR);
  const out: AutoPaperSummary = { eligible: eligible.map((s) => s.id), considered: 0, queued: 0, blocked: null };
  if (!eligible.length) return out;

  const [latest] = await db.select({ d: sql<string | null>`max(${schema.shadowSignals.signalDate})` }).from(schema.shadowSignals);
  if (!latest?.d) return out;
  const today = latest.d;
  const signals = await db.select().from(schema.shadowSignals)
    .where(and(eq(schema.shadowSignals.signalDate, today), inArray(schema.shadowSignals.setup, eligible.map((e) => e.id))));
  const order = new Map(eligible.map((e, k) => [e.id, k]));
  signals.sort((a, b) => order.get(a.setup)! - order.get(b.setup)! || b.score - a.score);
  out.considered = signals.length;

  const held = new Set((await db.select({ s: schema.trades.symbol }).from(schema.trades).where(inArray(schema.trades.status, ["pending_entry", "open"]))).map((r) => r.s));
  const pnl = await weekPnl();
  let committed = await committedCount();
  const budget = (settings.accountUsd * settings.riskPct) / 100;
  for (const s of signals) {
    const block = limitBlock({ committed, maxPositions: settings.maxPositions, weekPnlUsd: pnl, accountUsd: settings.accountUsd, weeklyLossLimitPct: settings.weeklyLossLimitPct });
    if (block) { out.blocked = block; break; }
    if (held.has(s.symbol)) continue;
    const p = s.plan as unknown as Plan;
    const risk = p.entry - p.stop;
    const shares = Math.min(Math.floor(budget / risk), Math.floor((settings.accountUsd * settings.maxPositionPct) / 100 / p.entry));
    if (!(shares >= 1)) continue;
    await db.insert(schema.candidates).values({
      scanId: 0, tradeDate: today, symbol: s.symbol, close: p.entry, score: s.score,
      entry: p.entry, stop: p.stop, target: p.targetR === null ? null : round2(p.entry + p.targetR * risk),
      shares, riskUsd: round2(shares * risk), positionUsd: round2(shares * p.entry), tradeable: true, reasons: [],
      status: "approved", why: s.why, setup: s.setup, plan: s.plan,
    });
    held.add(s.symbol);
    committed++;
    out.queued++;
  }
  return out;
}
