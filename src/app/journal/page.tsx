import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { ensureSchema } from "@/lib/db/migrate";
import { loadSettings, zar } from "@/lib/settings";
import { summarizeR } from "@/lib/stats";
import type { BacktestResults } from "@/lib/backtest/run";
import { Card, Empty, Pill, Stat, usd } from "@/components/ui";
import { saveJournal } from "./actions";

export const dynamic = "force-dynamic";

const rr = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`;
const RULES = [
  "Took a trade that was not on the scan",
  "Skipped an approved setup by feel",
  "Moved or removed a stop",
  "Exited early by hand",
  "Changed settings mid-week",
  "Other",
];

export default async function Journal() {
  const db = getDb();
  if (!db) return <Shell><Empty>Database not connected.</Empty></Shell>;
  await ensureSchema();
  const [closed, entries, [latestRun], settings] = await Promise.all([
    db.select().from(schema.trades).where(eq(schema.trades.status, "closed")).orderBy(desc(schema.trades.exitedAt)),
    db.select().from(schema.journal),
    db.select().from(schema.backtestRuns).orderBy(desc(schema.backtestRuns.id)).limit(1),
    loadSettings(),
  ]);
  const byTrade = new Map(entries.map((e) => [e.tradeId, e]));
  const rs = [...closed].reverse().map((t) => t.rMultiple ?? 0);
  const stats = summarizeR(rs);
  const pnl = closed.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const reviewed = closed.filter((t) => byTrade.has(t.id));
  const followed = reviewed.filter((t) => byTrade.get(t.id)!.rulesFollowed).length;
  const bt = latestRun ? (latestRun.results as BacktestResults).variants.find((v) => v.variant === "fixed") : undefined;

  return (
    <Shell>
      <Card title="Live results">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Stat label="Closed trades" value={stats.trades} />
          <Stat label="Win rate" value={stats.trades ? `${(stats.winRate * 100).toFixed(0)}%` : "–"} />
          <Stat label="Expectancy" value={stats.trades ? rr(stats.expectancyR) : "–"} sub="average R per trade" />
          <Stat label="Profit" value={usd(pnl)} sub={zar(pnl, settings.zarPerUsd)} />
          <Stat label="Rules followed" value={reviewed.length ? `${followed}/${reviewed.length}` : "–"} sub={`${closed.length - reviewed.length} not yet reviewed`} />
        </div>
        <div className="mt-4 rounded bg-bg px-4 py-3 text-sm">
          {bt ? (
            <>
              The backtest of the rules you trade live (fixed stop, 2R target) averaged <span className="num font-medium">{rr(bt.edge.expectancyR)}</span> per trade
              over {bt.edge.trades.toLocaleString()} trades, winning {(bt.edge.winRate * 100).toFixed(0)}% of the time.
              {" "}{stats.trades < 30
                ? `Live results become meaningful after about 30 trades. You have ${stats.trades}.`
                : stats.expectancyR >= bt.edge.expectancyR - 0.15
                  ? "Live results are in line with the backtest."
                  : "Live results are well below the backtest. Check the rule-breaking log below before changing anything."}
            </>
          ) : (
            <>Run a backtest to see what these rules earned historically, so live results have something to be compared with.</>
          )}
        </div>
      </Card>

      <Card title="Closed trades">
        {closed.length === 0 ? (
          <Empty>No closed trades yet. Each trade appears here when its stop, target or time stop is hit, ready for a one-line review.</Empty>
        ) : (
          <div className="space-y-3">
            {closed.map((t) => {
              const j = byTrade.get(t.id);
              return (
                <div key={t.id} className="rounded border border-line p-3">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
                    <span className="num font-medium">{t.symbol}</span>
                    <span className="num text-muted">{t.enteredAt?.toISOString().slice(0, 10)} to {t.exitedAt?.toISOString().slice(0, 10)}</span>
                    <span className="text-muted">{t.exitReason}</span>
                    <span className={`num ${(t.rMultiple ?? 0) >= 0 ? "text-up" : "text-down"}`}>{rr(t.rMultiple ?? 0)}</span>
                    <span className={`num ${(t.pnlUsd ?? 0) >= 0 ? "text-up" : "text-down"}`}>{usd(t.pnlUsd)}</span>
                    {j && <span className="ml-auto"><Pill tone={j.rulesFollowed ? "up" : "warn"}>{j.rulesFollowed ? "rules followed" : `broke: ${j.brokenRule ?? "a rule"}`}</Pill></span>}
                  </div>
                  {j?.note && <p className="mt-2 text-sm text-muted">{j.note}</p>}
                  {!j && (
                    <form action={saveJournal} className="mt-3 flex flex-wrap items-end gap-3 text-sm">
                      <input type="hidden" name="tradeId" value={t.id} />
                      <fieldset className="flex gap-3">
                        <legend className="mb-1 text-xs text-muted">Did you follow every rule?</legend>
                        <label className="flex items-center gap-1"><input id={`yes-${t.id}`} type="radio" name="rulesFollowed" value="yes" defaultChecked /> Yes</label>
                        <label className="flex items-center gap-1"><input id={`no-${t.id}`} type="radio" name="rulesFollowed" value="no" /> No</label>
                      </fieldset>
                      <label className="text-xs text-muted">
                        If not, which one
                        <select id={`rule-${t.id}`} name="brokenRule" className="mt-1 block rounded border border-line bg-bg px-2 py-1.5 text-sm text-ink">
                          <option value="">–</option>
                          {RULES.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </label>
                      <label className="min-w-0 flex-1 text-xs text-muted">
                        One line on how it felt
                        <input id={`note-${t.id}`} name="note" maxLength={1000} className="mt-1 block w-full rounded border border-line bg-bg px-2 py-1.5 text-sm text-ink" />
                      </label>
                      <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white">Save</button>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Journal</h1>
        <p className="mt-1 text-sm text-muted">One trade proves nothing. What matters is whether you follow the plan, and whether the plan matches its history.</p>
      </div>
      {children}
    </div>
  );
}
