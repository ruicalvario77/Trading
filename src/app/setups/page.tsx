import { desc, eq, sql } from "drizzle-orm";
import { getDb, rawSql, schema } from "@/lib/db";
import { ensureSchema } from "@/lib/db/migrate";
import { SETUPS } from "@/lib/setups/library";
import { setupStatuses, MIN_FORWARD_TRADES, type Stage } from "@/lib/setups/paper";
import type { SetupRunResults } from "@/lib/setups/run";
import { MIN_EDGE_R } from "@/lib/setups/engine";
import { MIN_DOLLAR_VOLUME, MIN_PRICE, MARKET_HISTORY_YEARS } from "@/lib/jobs/universe";
import { Card, Empty, Pill, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

const rr = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`;
const STAGE: Record<Stage, { tone: "up" | "down" | "warn" | "accent" | "muted"; label: string }> = {
  research: { tone: "muted", label: "Not tested" },
  failed: { tone: "down", label: "Failed backtest" },
  forward: { tone: "warn", label: "Forward testing" },
  paper: { tone: "up", label: "Paper trading" },
};

export default async function SetupsPage({ searchParams }: { searchParams: Promise<{ msg?: string; run?: string }> }) {
  const { msg, run } = await searchParams;
  const db = getDb();
  if (!db) return <Shell><Empty>Database not connected.</Empty></Shell>;
  await ensureSchema();
  const [[uni], [hist], [bf], { statuses, run: latestRun }] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int`, at: sql<string | null>`max(${schema.symbols.refreshedAt})` }).from(schema.symbols).where(eq(schema.symbols.active, true)),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.bars),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.backfills),
    setupStatuses(db),
  ]);
  const [sel] = run ? await db.select().from(schema.setupRuns).where(eq(schema.setupRuns.id, Number(run))).limit(1) : [];
  const r = (sel?.results as SetupRunResults | undefined) ?? latestRun?.results;
  const runId = sel?.id ?? latestRun?.id;
  const historyDone = bf.n >= uni.n && uni.n > 0;
  const [size] = (await rawSql().query("SELECT pg_database_size(current_database())::float8 AS b")) as { b: number }[];
  const usedMb = size.b / 1024 / 1024;
  const recentRuns = await db.select({ id: schema.setupRuns.id, createdAt: schema.setupRuns.createdAt }).from(schema.setupRuns).orderBy(desc(schema.setupRuns.id)).limit(5);

  return (
    <Shell>
      {msg && <div className="rounded border border-accent bg-accent-soft px-4 py-3 text-sm text-accent">{msg}</div>}

      <Card title="How a setup earns paper trading">
        <ol className="grid gap-3 text-sm sm:grid-cols-3">
          <li className="rounded bg-bg p-3"><div className="font-medium">1. Backtest across the market</div><p className="mt-1 text-muted">At least 100 trades, averaging {MIN_EDGE_R}R or more after costs, positive in both halves of the period, with evidence above the luck bar for testing {SETUPS.length} setups at once.</p></li>
          <li className="rounded bg-bg p-3"><div className="font-medium">2. Forward record</div><p className="mt-1 text-muted">Every night every setup&apos;s new signals are recorded and followed with the same rules. No hindsight is possible. It needs {MIN_FORWARD_TRADES} closed trades averaging above zero.</p></li>
          <li className="rounded bg-bg p-3"><div className="font-medium">3. Paper trading</div><p className="mt-1 text-muted">Its signals are sized to your rules and placed on Alpaca paper automatically. Live money stays your decision, after six months.</p></li>
        </ol>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Universe">
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Tradable symbols" value={uni.n.toLocaleString()} />
            <Stat label="With history" value={<span className="text-base">{bf.n.toLocaleString()} / {uni.n.toLocaleString()}</span>} />
            <Stat label="Daily bars" value={<span className="text-base">{hist.n.toLocaleString()}</span>} />
          </div>
          <p className="mt-3 text-sm text-muted">
            Every US stock and ETF at ${MIN_PRICE} or more, trading at least ${(MIN_DOLLAR_VOLUME / 1e6).toFixed(0)} million a day. Rebuilt weekly.
            {" "}{uni.at ? `Last rebuilt ${new Date(uni.at).toLocaleDateString("en-ZA")}.` : "Not built yet."} {MARKET_HISTORY_YEARS} years of history per symbol.
          </p>
          <p className={`mt-2 text-sm ${usedMb > 430 ? "text-down" : usedMb > 380 ? "text-warn" : "text-muted"}`}>
            Database: {usedMb.toFixed(0)} MB of the free plan&apos;s 512 MB.{usedMb > 430 ? " Nearly full: new prices will stop saving soon." : ""}
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <form action="/api/universe" method="post"><button type="submit" className="rounded border border-line px-3 py-1.5 text-xs">Rebuild universe now</button></form>
            <form action="/api/backfill" method="post">
              <input type="hidden" name="back" value="setups" />
              <button type="submit" disabled={historyDone} className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">{historyDone ? "History loaded" : "Load history"}</button>
            </form>
          </div>
          {!historyDone && uni.n > 0 && <p className="mt-2 text-xs text-muted">Each press loads for about four minutes. The nightly job also loads a share each night.</p>}
        </Card>

        <Card title="Backtest all setups">
          <p className="text-sm text-muted">Runs all {SETUPS.length} setups on every tradable symbol over the stored history. Takes one to three minutes.</p>
          <form action="/api/setups" method="post" className="mt-3">
            <button type="submit" disabled={!historyDone} className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">Run setup backtest</button>
          </form>
          {!historyDone && <p className="mt-2 text-xs text-warn">Load history for the whole universe first.</p>}
          {recentRuns.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {recentRuns.map((x) => (
                <a key={x.id} href={`/setups?run=${x.id}`} className={`rounded border px-2 py-0.5 ${x.id === runId ? "border-accent text-accent" : "border-line text-muted"}`}>#{x.id} · {x.createdAt.toLocaleDateString("en-ZA")}</a>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="Setups" aside={r ? <span className="text-xs text-muted">Backtest {r.firstDate} to {r.lastDate} · {r.symbols.toLocaleString()} symbols · luck bar {r.luckBar.toFixed(2)}</span> : null}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1 pr-3">Setup</th><th className="py-1 pr-3">Stage</th>
                <th className="py-1 pr-3">Backtest trades</th><th className="py-1 pr-3">Avg per trade</th><th className="py-1 pr-3">Win rate</th>
                <th className="py-1 pr-3">Evidence</th><th className="py-1 pr-3">Halves</th>
                <th className="py-1 pr-3">Forward closed</th><th className="py-1">Forward avg</th>
              </tr>
            </thead>
            <tbody>
              {SETUPS.map((s) => {
                const st = statuses.find((x) => x.id === s.id)!;
                const bt = r?.setups.find((x) => x.id === s.id && x.version === s.version);
                return (
                  <tr key={s.id} className="border-t border-line align-top">
                    <td className="py-2 pr-3"><a href={`#${s.id}`} className="font-medium hover:underline">{s.name}</a> <span className="num text-xs text-muted">{s.version}</span></td>
                    <td className="py-2 pr-3"><Pill tone={STAGE[st.stage].tone}>{STAGE[st.stage].label}</Pill></td>
                    <td className="num py-2 pr-3">{bt ? bt.edge.trades.toLocaleString() : "–"}</td>
                    <td className={`num py-2 pr-3 ${bt ? (bt.edge.expectancyR >= MIN_EDGE_R ? "text-up" : "text-down") : ""}`}>{bt ? rr(bt.edge.expectancyR) : "–"}</td>
                    <td className="num py-2 pr-3">{bt ? `${(bt.edge.winRate * 100).toFixed(0)}%` : "–"}</td>
                    <td className={`num py-2 pr-3 ${bt && r ? (bt.t >= r.luckBar ? "text-up" : "text-down") : ""}`}>{bt ? bt.t.toFixed(2) : "–"}</td>
                    <td className="num py-2 pr-3">{bt ? `${rr(bt.earlier.expectancyR)} / ${rr(bt.later.expectancyR)}` : "–"}</td>
                    <td className="num py-2 pr-3">{st.forward.closed.trades} <span className="text-xs text-muted">({st.forward.open} open)</span></td>
                    <td className="num py-2">{st.forward.closed.trades ? rr(st.forward.closed.expectancyR) : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">
          Evidence is the average result divided by its uncertainty, measured per trading day so that trades on the same day are not counted as independent.
          With {SETUPS.length} setups tested at once, a setup needs at least {r ? r.luckBar.toFixed(2) : "2.50"} for its edge not to be luck.
        </p>
      </Card>

      {SETUPS.map((s) => {
        const st = statuses.find((x) => x.id === s.id)!;
        const bt = r?.setups.find((x) => x.id === s.id && x.version === s.version);
        return (
          <section key={s.id} id={s.id} className="rounded-lg border border-line bg-surface p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">{s.name} <span className="num text-xs font-normal text-muted">{s.version}</span></h2>
                <p className="mt-1 text-sm text-muted">{s.summary}</p>
              </div>
              <Pill tone={STAGE[st.stage].tone}>{STAGE[st.stage].label}</Pill>
            </div>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">{s.rules.map((x) => <li key={x}>{x}</li>)}</ul>
            <p className="mt-3 text-sm">{st.detail}</p>
            {bt && (
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="py-1 pr-3">Year</th><th className="py-1 pr-3">Trades</th><th className="py-1">Avg per trade</th></tr></thead>
                    <tbody>
                      {bt.perYear.map((y) => (
                        <tr key={y.year} className="border-t border-line"><td className="num py-1 pr-3">{y.year}</td><td className="num py-1 pr-3">{y.trades}</td><td className={`num py-1 ${y.avgR >= 0 ? "text-up" : "text-down"}`}>{rr(y.avgR)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="text-sm text-muted">
                  <p>{bt.funnel.signals.toLocaleString()} signals. {Object.entries(bt.funnel.rejected).map(([k, n]) => `${n.toLocaleString()} ${k}`).join(", ") || "None rejected"}. {bt.funnel.unfilled.toLocaleString()} never triggered.</p>
                  <p className="mt-2">Exits: {Object.entries(bt.exitReasons).map(([k, n]) => `${n.toLocaleString()} ${k === "strong" ? "strong close" : k === "end" ? "open at end" : k}`).join(", ")}.</p>
                  <p className="mt-2">Average win {rr(bt.edge.avgWinR)}, average loss {rr(bt.edge.avgLossR)}, worst losing streak {bt.edge.maxLosingStreak}.</p>
                </div>
              </div>
            )}
          </section>
        );
      })}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Setups</h1>
        <p className="mt-1 text-sm text-muted">Swing setups across the whole US market. Each one has to prove itself on history and then going forward before it trades.</p>
      </div>
      {children}
    </div>
  );
}
