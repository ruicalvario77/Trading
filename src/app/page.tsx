import { desc, sql } from "drizzle-orm";
import { setupStatus, isPaper } from "@/lib/env";
import { getDb, schema } from "@/lib/db";
import { alpacaConfigured, getAccount, getClock } from "@/lib/alpaca";
import { loadSettings, zar } from "@/lib/settings";
import { Card, Stat, Pill, Empty, usd } from "@/components/ui";

export const dynamic = "force-dynamic";

async function dbSummary() {
  const db = getDb();
  if (!db) return null;
  try {
    const [[syms], [bars], runs] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(schema.symbols),
      db.select({ n: sql<number>`count(*)::int`, latest: sql<string | null>`max(${schema.bars.date})` }).from(schema.bars),
      db.select().from(schema.jobRuns).orderBy(desc(schema.jobRuns.id)).limit(5),
    ]);
    return { symbols: syms.n, bars: bars.n, latest: bars.latest, runs };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function broker() {
  if (!alpacaConfigured()) return null;
  try {
    const [account, clock] = await Promise.all([getAccount(), getClock()]);
    return { account, clock };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export default async function Overview({ searchParams }: { searchParams: Promise<{ job?: string; ok?: string }> }) {
  const sp = await searchParams;
  const status = setupStatus();
  const missing = status.filter((s) => !s.present);
  const [settings, summary, brk] = await Promise.all([loadSettings(), dbSummary(), broker()]);
  const riskUsd = (settings.accountUsd * settings.riskPct) / 100;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-muted">Paper trading. Nothing here places real orders.</p>
      </div>

      {sp.job && (
        <div className={`rounded border px-4 py-3 text-sm ${sp.ok === "1" ? "border-up bg-up-soft text-up" : "border-down bg-down-soft text-down"}`}>
          Job <span className="num">{sp.job}</span> {sp.ok === "1" ? "finished" : "failed"}. Details in the job log below.
        </div>
      )}

      {missing.length > 0 && (
        <Card title="Setup">
          <ul className="space-y-2 text-sm">
            {missing.map((s) => (
              <li key={s.key} className="flex items-start justify-between gap-3">
                <div>
                  <div>{s.label} <span className="num text-xs text-muted">{s.key}</span></div>
                  <div className="text-xs text-muted">{s.hint}</div>
                </div>
                <Pill tone="warn">missing</Pill>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Account rules">
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Account" value={usd(settings.accountUsd, 0)} sub={zar(settings.accountUsd, settings.zarPerUsd)} />
            <Stat label="Risk per trade" value={usd(riskUsd)} sub={`${settings.riskPct}% · ${zar(riskUsd, settings.zarPerUsd)}`} />
            <Stat label="Max positions" value={settings.maxPositions} />
            <Stat label="Weekly loss limit" value={`${settings.weeklyLossLimitPct}%`} sub={usd((settings.accountUsd * settings.weeklyLossLimitPct) / 100)} />
          </div>
        </Card>

        <Card title="Broker" aside={<Pill tone={isPaper() ? "accent" : "down"}>{isPaper() ? "paper" : "LIVE"}</Pill>}>
          {!brk ? (
            <Empty>Alpaca keys not set. The scanner needs them for market data.</Empty>
          ) : "error" in brk ? (
            <p className="text-sm text-down">{brk.error}</p>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Status" value={<span className="text-base">{brk.account.status}</span>} />
              <Stat label="Market" value={<span className="text-base">{brk.clock.is_open ? "open" : "closed"}</span>}
                sub={`next ${brk.clock.is_open ? "close" : "open"} ${new Date(brk.clock.is_open ? brk.clock.next_close : brk.clock.next_open).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", dateStyle: "short", timeStyle: "short" })} SAST`} />
              <Stat label="Paper equity" value={usd(Number(brk.account.equity), 0)} sub="Alpaca's balance. Sizing uses the account rules, not this." />
              <Stat label="Blocked" value={<span className="text-base">{brk.account.trading_blocked ? "yes" : "no"}</span>} />
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Data and jobs"
        aside={
          summary && !("error" in summary) ? (
            <form action="/api/cron/after-close" method="post">
              <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white">Run after-close job now</button>
            </form>
          ) : null
        }
      >
        {!summary ? (
          <Empty>Database not connected.</Empty>
        ) : "error" in summary ? (
          <p className="text-sm text-down">{summary.error}</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <Stat label="Symbols" value={summary.symbols} />
              <Stat label="Daily bars" value={summary.bars.toLocaleString()} />
              <Stat label="Latest bar" value={<span className="text-base">{summary.latest ?? "none"}</span>} />
            </div>
            {summary.runs.length === 0 ? (
              <Empty>No job has run yet. The nightly job runs at 00:00 SAST on weekdays, or press the button.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted">
                    <tr><th className="py-1 pr-3">Job</th><th className="py-1 pr-3">Started (SAST)</th><th className="py-1 pr-3">Result</th><th className="py-1">Summary</th></tr>
                  </thead>
                  <tbody>
                    {summary.runs.map((r) => (
                      <tr key={r.id} className="border-t border-line align-top">
                        <td className="num py-2 pr-3">{r.job}</td>
                        <td className="num py-2 pr-3 whitespace-nowrap">{r.startedAt.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", dateStyle: "short", timeStyle: "short" })}</td>
                        <td className="py-2 pr-3">{r.ok === null ? <Pill tone="muted">running</Pill> : r.ok ? <Pill tone="up">ok</Pill> : <Pill tone="down">failed</Pill>}</td>
                        <td className="num py-2 text-xs text-muted break-all">{r.error ?? JSON.stringify(r.summary)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
