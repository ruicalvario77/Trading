import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { ensureSchema } from "@/lib/db/migrate";
import { STRATEGIES, type StrategyDef } from "@/lib/lab/strategies";
import type { LabResults, LabStrategyResult } from "@/lib/lab/run";
import type { Metrics } from "@/lib/lab/metrics";
import { Card, Empty, Pill } from "@/components/ui";
import { revealHoldout } from "./actions";

export const dynamic = "force-dynamic";

const pct = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;

function passes(s: Metrics, spy: Metrics) {
  return { beatsReturn: s.cagrPct > spy.cagrPct, smallerFall: s.maxDrawdownPct < spy.maxDrawdownPct };
}

export default async function LabPage({ searchParams }: { searchParams: Promise<{ run?: string; msg?: string }> }) {
  const { run, msg } = await searchParams;
  const db = getDb();
  if (!db) return <Shell><Empty>Database not connected.</Empty></Shell>;
  await ensureSchema();
  const [runs, reveals] = await Promise.all([
    db.select({ id: schema.labRuns.id, createdAt: schema.labRuns.createdAt }).from(schema.labRuns).orderBy(desc(schema.labRuns.id)).limit(6),
    db.select().from(schema.labReveals).orderBy(schema.labReveals.revealedAt),
  ]);
  const selectedId = run ? Number(run) : runs[0]?.id;
  const [sel] = selectedId ? await db.select().from(schema.labRuns).where(eq(schema.labRuns.id, selectedId)).limit(1) : [];
  const r = sel?.results as LabResults | undefined;
  const revealed = new Map(reveals.map((x) => [`${x.strategy}@${x.version}`, x]));

  return (
    <Shell>
      {msg && <div className="rounded border border-down bg-down-soft px-4 py-3 text-sm text-down">{msg}</div>}

      <Card title="How this test works">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm">
          <li>Three strategies were written down, with every number fixed, before any of them was tested. The rules are listed under each one.</li>
          <li>History up to the end of 2022 is the <span className="font-medium">build period</span>. You can look at it as often as you like.</li>
          <li>2023 to today is <span className="font-medium">sealed</span>. Each strategy&apos;s sealed result can be opened once. Opening it is recorded with the date and cannot be undone.</li>
          <li>A strategy <span className="font-medium">passes</span> only if, in the sealed period, it earned more per year than buying and holding SPY and its worst fall was smaller.</li>
          <li>If a rule is changed after opening, it becomes a new version with its own seal, and the history of every opened version stays on this page.</li>
        </ol>
        <form action="/api/lab" method="post" className="mt-4 flex flex-wrap items-center gap-3">
          <button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white">{runs.length ? "Run the lab again on the latest data" : "Run the lab"}</button>
          <span className="text-xs text-muted">Takes about a minute. Needs the price history loaded on the Backtest page.</span>
        </form>
      </Card>

      {!r ? (
        <Card><Empty>No lab run yet. Press Run the lab.</Empty></Card>
      ) : (
        <>
          <p className="text-sm text-muted">
            Run #{sel!.id} on {sel!.createdAt.toLocaleDateString("en-ZA")}. Build period {r.start} to 2022-12-31, sealed period {r.split} to {r.end}.
            {" "}Results in percent, simulated on a ${(r.notional / 1000).toFixed(0)}k account so whole-share rounding does not distort them. Dividends are left out for every strategy and for SPY alike.
          </p>
          {STRATEGIES.map((def) => {
            const res = r.strategies.find((s) => s.id === def.id && s.version === def.version);
            if (!res) return null;
            return <StrategyCard key={def.id} def={def} res={res} r={r} runId={sel!.id} reveal={revealed.get(`${def.id}@${def.version}`)} />;
          })}
          <Summary r={r} revealed={revealed} />
        </>
      )}

      {reveals.length > 0 && (
        <Card title="Seal log">
          <ul className="space-y-1 text-sm">
            {reveals.map((x) => (
              <li key={`${x.strategy}@${x.version}`} className="num text-muted">
                {x.revealedAt.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", dateStyle: "medium", timeStyle: "short" })} · opened {x.strategy} {x.version} (run #{x.runId})
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Shell>
  );
}

function MetricRow({ label, m, spy }: { label: string; m: Metrics; spy?: Metrics }) {
  return (
    <tr className="border-t border-line">
      <td className="py-2 pr-3">{label}</td>
      <td className={`num py-2 pr-3 ${spy ? (m.cagrPct > spy.cagrPct ? "text-up" : "text-down") : ""}`}>{pct(m.cagrPct)}</td>
      <td className={`num py-2 pr-3 ${spy ? (m.maxDrawdownPct < spy.maxDrawdownPct ? "text-up" : "text-down") : ""}`}>−{m.maxDrawdownPct.toFixed(1)}%</td>
      <td className="num py-2 pr-3">{pct(m.totalReturnPct, 0)}</td>
      <td className="num py-2 pr-3">{m.volPct.toFixed(1)}%</td>
      <td className="num py-2 pr-3">{m.exposurePct.toFixed(0)}%</td>
      <td className="num py-2 pr-3">{spy ? m.trades : "–"}</td>
      <td className="num py-2">{m.winRate === null ? "–" : `${(m.winRate * 100).toFixed(0)}%`}</td>
    </tr>
  );
}

function MetricsTable({ rows }: { rows: { label: string; m: Metrics; spy?: Metrics }[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="py-1 pr-3">Period</th><th className="py-1 pr-3">Per year</th><th className="py-1 pr-3">Worst fall</th>
            <th className="py-1 pr-3">Total</th><th className="py-1 pr-3">Volatility</th><th className="py-1 pr-3">Time invested</th>
            <th className="py-1 pr-3">Trades</th><th className="py-1">Winners</th>
          </tr>
        </thead>
        <tbody>{rows.map((x) => <MetricRow key={x.label} {...x} />)}</tbody>
      </table>
    </div>
  );
}

function StrategyCard({ def, res, r, runId, reveal }: { def: StrategyDef; res: LabStrategyResult; r: LabResults; runId: number; reveal?: { revealedAt: Date; runId: number } }) {
  const open = !!reveal;
  const b = passes(res.build, r.benchmark.build);
  const h = passes(res.holdout, r.benchmark.holdout);
  const pass = h.beatsReturn && h.smallerFall;
  return (
    <section id={def.id} className="rounded-lg border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{def.name} <span className="num text-xs font-normal text-muted">{def.version}</span></h2>
          <p className="mt-1 text-sm text-muted">{def.summary}</p>
        </div>
        {open ? <Pill tone={pass ? "up" : "down"}>{pass ? "Passed on sealed data" : "Failed on sealed data"}</Pill> : <Pill tone="muted">Sealed result not opened</Pill>}
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-muted">The rules, fixed before testing</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">{def.rules.map((x) => <li key={x}>{x}</li>)}</ul>
      </details>

      <div className="mt-4">
        <MetricsTable
          rows={[
            { label: "Build period", m: res.build, spy: r.benchmark.build },
            { label: "SPY, same period", m: r.benchmark.build },
            ...(open ? [{ label: "Sealed period", m: res.holdout, spy: r.benchmark.holdout }, { label: "SPY, sealed period", m: r.benchmark.holdout }] : []),
          ]}
        />
        <p className="mt-2 text-xs text-muted">
          Build period: {b.beatsReturn ? "earned more than SPY" : "earned less than SPY"}, {b.smallerFall ? "with a smaller worst fall" : "with a deeper worst fall"}.
          {" "}Green means better than SPY, red means worse.
        </p>
      </div>

      <Chart res={res} bench={r.benchmark.curve} until={open ? r.end : "2022-12-31"} split={r.split} />

      {open ? (
        <p className="mt-3 text-xs text-muted">
          Sealed result opened on {reveal!.revealedAt.toLocaleDateString("en-ZA")} (run #{reveal!.runId}). {pass
            ? "It beat SPY on both counts in data it was never built on."
            : `${h.beatsReturn ? "It earned more than SPY" : "It earned less than SPY"} and ${h.smallerFall ? "fell less" : "fell further"}, so it does not meet the pass mark.`}
        </p>
      ) : (
        <form action={revealHoldout} className="mt-4 flex flex-wrap items-center gap-3 rounded bg-bg px-3 py-2.5 text-sm">
          <input type="hidden" name="strategy" value={def.id} />
          <input type="hidden" name="runId" value={runId} />
          <label className="flex items-center gap-2">
            <input id={`confirm-${def.id}`} type="checkbox" name="confirm" value="yes" required />
            I understand this opens the 2023 to today result once, and it is recorded.
          </label>
          <button type="submit" className="rounded border border-accent px-3 py-1.5 text-xs font-medium text-accent">Open sealed result</button>
        </form>
      )}
    </section>
  );
}

function Chart({ res, bench, until, split }: { res: LabStrategyResult; bench: { date: string; value: number }[]; until: string; split: string }) {
  const a = res.curve.filter((p) => p.date <= until);
  const s = bench.filter((p) => p.date <= until);
  if (a.length < 2 || s.length < 2) return null;
  const W = 640, H = 200, L = 44, R = 10, T = 10, B = 24;
  const t0 = Date.parse(a[0].date), t1 = Date.parse(a[a.length - 1].date);
  const all = [...a, ...s].map((p) => p.value);
  const lo = Math.min(...all) * 0.97, hi = Math.max(...all) * 1.03;
  const x = (d: string) => L + ((Date.parse(d) - t0) / Math.max(t1 - t0, 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const path = (pts: { date: string; value: number }[]) => pts.map((p, k) => `${k ? "L" : "M"}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const years: string[] = [];
  for (let yr = Number(a[0].date.slice(0, 4)) + 1; yr <= Number(a[a.length - 1].date.slice(0, 4)); yr++) years.push(`${yr}-01-01`);
  const grid = [lo + (hi - lo) * 0.2, lo + (hi - lo) * 0.5, lo + (hi - lo) * 0.8];
  return (
    <div className="mt-4 overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full min-w-[480px]" role="img" aria-label={`Growth of 100 for ${res.id} against SPY`}>
        {grid.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--line)" />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize={10.5} fill="var(--muted)">{v.toFixed(0)}</text>
          </g>
        ))}
        {years.map((d) => <text key={d} x={x(d)} y={H - 7} textAnchor="middle" fontSize={10.5} fill="var(--muted)">{d.slice(0, 4)}</text>)}
        {until > split && <line x1={x(split)} x2={x(split)} y1={T} y2={H - B} stroke="var(--muted)" strokeDasharray="4 4" />}
        <path d={path(s)} fill="none" stroke="var(--muted)" strokeWidth={1.5} />
        <path d={path(a)} fill="none" stroke="var(--accent)" strokeWidth={2} />
      </svg>
      <div className="mt-1 flex flex-wrap gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4" style={{ background: "var(--accent)" }} />Strategy, growth of 100</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4" style={{ background: "var(--muted)" }} />Buy and hold SPY</span>
        {until > split && <span>Dashed line: start of the sealed period</span>}
      </div>
    </div>
  );
}

function Summary({ r, revealed }: { r: LabResults; revealed: Map<string, unknown> }) {
  const opened = STRATEGIES.filter((d) => revealed.has(`${d.id}@${d.version}`));
  if (opened.length < STRATEGIES.length) {
    return (
      <Card title="Verdict">
        <p className="text-sm text-muted">
          {opened.length} of {STRATEGIES.length} sealed results opened. The overall verdict appears once all are open. A sensible order: read every build-period
          result first, decide which ones you would trade if the sealed period agrees, then open them.
        </p>
      </Card>
    );
  }
  const passed = STRATEGIES.filter((d) => {
    const s = r.strategies.find((x) => x.id === d.id)!;
    const p = passes(s.holdout, r.benchmark.holdout);
    return p.beatsReturn && p.smallerFall;
  });
  return (
    <Card title="Verdict">
      {passed.length ? (
        <p className="text-sm">
          Passed: <span className="font-medium">{passed.map((p) => p.name).join(", ")}</span>. Next step is paper trading it with the same rules for at least
          30 trades or six months and checking it behaves like the test. One pass on under four years of data is encouraging, not proof.
        </p>
      ) : (
        <p className="text-sm">
          None of the strategies beat buying and holding SPY on data they were not built on. The honest conclusion: keep long-term money in a low-cost
          index fund, and treat trading as a small, paper-first learning project.
        </p>
      )}
    </Card>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Strategy lab</h1>
        <p className="mt-1 text-sm text-muted">Three ideas, rules fixed in advance, judged on years of data they never saw.</p>
      </div>
      {children}
    </div>
  );
}
