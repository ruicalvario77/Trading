import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { ensureSchema } from "@/lib/db/migrate";
import { INTRADAY_SETUPS } from "@/lib/intraday/setups";
import { DAY_SYMBOLS, MIN_DAY_FORWARD_TRADES, intradayForwardStats, type IntradayResults } from "@/lib/intraday/run";
import { hhmm } from "@/lib/intraday/session";
import { MIN_EDGE_R } from "@/lib/setups/engine";
import { Card, Empty, Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

const rr = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`;

export default async function DayTradePage({ searchParams }: { searchParams: Promise<{ run?: string; msg?: string }> }) {
  const { run, msg } = await searchParams;
  const db = getDb();
  if (!db) return <Shell><Empty>Database not connected.</Empty></Shell>;
  await ensureSchema();
  const runs = await db.select({ id: schema.intradayRuns.id, createdAt: schema.intradayRuns.createdAt }).from(schema.intradayRuns).orderBy(desc(schema.intradayRuns.id)).limit(6);
  const selectedId = run ? Number(run) : runs[0]?.id;
  const [sel] = selectedId ? await db.select().from(schema.intradayRuns).where(eq(schema.intradayRuns.id, selectedId)).limit(1) : [];
  const r = sel?.results as IntradayResults | undefined;
  const fwd = await intradayForwardStats(db);

  return (
    <Shell>
      {msg && <div className="rounded border border-down bg-down-soft px-4 py-3 text-sm text-down">{msg}</div>}

      <Card title="Where day trading stands">
        <ol className="grid gap-3 text-sm sm:grid-cols-3">
          <li className="rounded bg-bg p-3"><div className="font-medium">1. Research, now</div><p className="mt-1 text-muted">Five-minute bars for the {DAY_SYMBOLS} most traded stocks and ETFs. Each setup is backtested with the same pass rules as the swing setups.</p></li>
          <li className="rounded bg-bg p-3"><div className="font-medium">2. Forward record, now</div><p className="mt-1 text-muted">Every morning before the US open, yesterday&apos;s session is replayed with every setup and the trades are stored. Day trades finish the same day, so evidence builds fast.</p></li>
          <li className="rounded bg-bg p-3"><div className="font-medium">3. Paper trading, later</div><p className="mt-1 text-muted">Needs an always-on worker watching prices during US hours (about $5 a month). Built only once a setup passes both stages.</p></li>
        </ol>
        <p className="mt-3 text-xs text-muted">
          Live day trading on a US margin account under $25,000 is limited to three day trades in five days. R100,000 is about $5,600, so a passing setup would
          mean either a cash account (each rand of cash usable once per trading day) or a larger account.
        </p>
      </Card>

      <Card title="Backtest the intraday setups">
        <form action="/api/daytrade" method="post" className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-xs text-muted">Period</span>
            <select id="months" name="months" defaultValue="6" className="mt-1 rounded border border-line bg-bg px-2 py-1.5">
              <option value="3">Last 3 months</option>
              <option value="6">Last 6 months</option>
              <option value="9">Last 9 months</option>
            </select>
          </label>
          <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white">Run intraday backtest</button>
          <span className="text-xs text-muted">Downloads about 15,000 five-minute bars per stock per 6 months. Takes 1 to 4 minutes; 9 months may hit the time limit.</span>
        </form>
        {runs.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {runs.map((x) => (
              <a key={x.id} href={`/daytrade?run=${x.id}`} className={`rounded border px-2 py-0.5 ${x.id === selectedId ? "border-accent text-accent" : "border-line text-muted"}`}>#{x.id} · {x.createdAt.toLocaleDateString("en-ZA")}</a>
            ))}
          </div>
        )}
      </Card>

      <Card title="Setups" aside={r ? <span className="text-xs text-muted">Backtest {r.from} to {r.to} · {r.symbols} symbols · {r.sessions.toLocaleString()} sessions · luck bar {r.luckBar.toFixed(2)}</span> : null}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1 pr-3">Setup</th><th className="py-1 pr-3">Backtest</th><th className="py-1 pr-3">Trades</th><th className="py-1 pr-3">Avg per trade</th>
                <th className="py-1 pr-3">Win rate</th><th className="py-1 pr-3">Evidence</th><th className="py-1 pr-3">Halves</th>
                <th className="py-1 pr-3">Forward trades</th><th className="py-1">Forward avg</th>
              </tr>
            </thead>
            <tbody>
              {INTRADAY_SETUPS.map((s) => {
                const bt = r?.setups.find((x) => x.id === s.id && x.version === s.version);
                const f = fwd.stats.find((x) => x.id === s.id)!;
                return (
                  <tr key={s.id} className="border-t border-line align-top">
                    <td className="py-2 pr-3"><a href={`#${s.id}`} className="font-medium hover:underline">{s.name}</a> <span className="num text-xs text-muted">{s.version}</span></td>
                    <td className="py-2 pr-3">{bt ? <Pill tone={bt.verdict.pass ? "up" : "down"}>{bt.verdict.pass ? "passed" : "failed"}</Pill> : <Pill tone="muted">not run</Pill>}</td>
                    <td className="num py-2 pr-3">{bt ? bt.edge.trades.toLocaleString() : "–"}</td>
                    <td className={`num py-2 pr-3 ${bt ? (bt.edge.expectancyR >= MIN_EDGE_R ? "text-up" : "text-down") : ""}`}>{bt ? rr(bt.edge.expectancyR) : "–"}</td>
                    <td className="num py-2 pr-3">{bt ? `${(bt.edge.winRate * 100).toFixed(0)}%` : "–"}</td>
                    <td className={`num py-2 pr-3 ${bt && r ? (bt.t >= r.luckBar ? "text-up" : "text-down") : ""}`}>{bt ? bt.t.toFixed(2) : "–"}</td>
                    <td className="num py-2 pr-3">{bt ? `${rr(bt.earlier.expectancyR)} / ${rr(bt.later.expectancyR)}` : "–"}</td>
                    <td className="num py-2 pr-3">{f.trades.trades}</td>
                    <td className="num py-2">{f.trades.trades ? rr(f.trades.expectancyR) : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">
          Same pass rules as the swing setups: 100+ trades, at least {MIN_EDGE_R}R per trade after 0.05% costs each side, positive in both halves, and evidence above the luck bar.
          A setup that passes also needs {MIN_DAY_FORWARD_TRADES} forward trades averaging above zero.
          {" "}Forward record: {fwd.daysRecorded} session{fwd.daysRecorded === 1 ? "" : "s"} replayed{fwd.firstDay ? `, ${fwd.firstDay} to ${fwd.lastDay}` : " so far; the first one is recorded on the next weekday morning"}.
        </p>
      </Card>

      {INTRADAY_SETUPS.map((s) => {
        const bt = r?.setups.find((x) => x.id === s.id && x.version === s.version);
        return (
          <section key={s.id} id={s.id} className="rounded-lg border border-line bg-surface p-5">
            <h2 className="text-base font-semibold">{s.name} <span className="num text-xs font-normal text-muted">{s.version}</span></h2>
            <p className="mt-1 text-sm text-muted">{s.summary}</p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">{s.rules.map((x) => <li key={x}>{x}</li>)}</ul>
            {bt && (
              <>
                <p className="mt-3 text-sm">{bt.verdict.pass ? "Passed the backtest." : `Backtest: ${bt.verdict.reasons.join("; ")}.`}</p>
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="py-1 pr-3">Month</th><th className="py-1 pr-3">Trades</th><th className="py-1">Avg</th></tr></thead>
                    <tbody>{bt.perMonth.map((m) => <tr key={m.month} className="border-t border-line"><td className="num py-1 pr-3">{m.month}</td><td className="num py-1 pr-3">{m.trades}</td><td className={`num py-1 ${m.avgR >= 0 ? "text-up" : "text-down"}`}>{rr(m.avgR)}</td></tr>)}</tbody>
                  </table>
                  <div className="text-sm text-muted">
                    <p>By entry time: {bt.byEntryHour.map((h) => `${h.hour} ${h.trades} trades ${rr(h.avgR)}`).join(" · ") || "none"}.</p>
                    <p className="mt-2">Exits: {Object.entries(bt.exits).map(([k, n]) => `${n} ${k === "close" ? "at the close" : k}`).join(", ") || "none"}.</p>
                    <p className="mt-2">Average win {rr(bt.edge.avgWinR)}, average loss {rr(bt.edge.avgLossR)}, worst losing streak {bt.edge.maxLosingStreak}.</p>
                    {bt.recent.length > 0 && <p className="mt-2">Latest: {bt.recent.slice(0, 5).map((t) => `${t.symbol} ${t.date} ${hhmm(t.entryM)} ${rr(t.r)}`).join(" · ")}</p>}
                  </div>
                </div>
              </>
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
        <h1 className="text-2xl font-semibold tracking-tight">Day trading</h1>
        <p className="mt-1 text-sm text-muted">Research and a forward record for intraday setups. No orders are placed yet.</p>
      </div>
      {children}
    </div>
  );
}
