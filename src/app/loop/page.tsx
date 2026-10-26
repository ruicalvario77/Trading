import { asc, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { ensureSchema } from "@/lib/db/migrate";
import { loadSettings, zar } from "@/lib/settings";
import { configById, FAMILY_LABEL, BASELINE_ID, type Family } from "@/lib/loop/families";
import type { ResearchResults } from "@/lib/loop/run";
import { windowMetrics, type CurvePoint } from "@/lib/lab/metrics";
import { Card, Empty, Pill, Stat, usd } from "@/components/ui";
import { pauseAction, researchAction, startAction } from "./actions";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const pct = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;
const riskAdj = (m: { cagrPct: number; volPct: number }) => (m.volPct > 0 ? m.cagrPct / m.volPct : 0);

export default async function LoopPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const db = getDb();
  if (!db) return <Shell><Empty>Database not connected.</Empty></Shell>;
  await ensureSchema();
  const [[state], holdings, equityRows, orders, research, settings] = await Promise.all([
    db.select().from(schema.loopState).where(eq(schema.loopState.id, 1)).limit(1),
    db.select().from(schema.loopHoldings),
    db.select().from(schema.loopEquity).orderBy(asc(schema.loopEquity.date)),
    db.select().from(schema.loopOrders).orderBy(desc(schema.loopOrders.id)).limit(30),
    db.select().from(schema.loopResearch).orderBy(desc(schema.loopResearch.id)).limit(12),
    loadSettings(),
  ]);
  const latest = research[0]?.results as ResearchResults | undefined;
  const champ = configById(state.champion ?? BASELINE_ID);

  // Paper performance against SPY over the same days.
  const paperCurve: CurvePoint[] = equityRows.map((r) => ({ date: r.date, equity: r.equity, invested: r.equity }));
  const spyCurve: CurvePoint[] = equityRows.map((r) => ({ date: r.date, equity: r.spyClose, invested: r.spyClose }));
  const first = equityRows[0]?.date ?? "";
  const lastD = equityRows[equityRows.length - 1]?.date ?? "";
  const paper = equityRows.length > 1 ? windowMetrics(paperCurve, [], first, lastD) : null;
  const spy = equityRows.length > 1 ? windowMetrics(spyCurve, [], first, lastD) : null;
  const filled = orders.filter((o) => o.status === "filled" && o.fillPrice);
  const avgGap = filled.length ? filled.reduce((s, o) => s + Math.abs(o.fillPrice! - o.expectedPrice) / o.expectedPrice, 0) / filled.length * 100 : null;
  const openOrders = orders.filter((o) => o.status === "open");

  const checks = [
    { ok: equityRows.length >= 126, label: "Six months of paper trading", detail: `${equityRows.length} of 126 trading days recorded.` },
    // Whole shares and a small cash buffer mean holding the index on paper trails SPY slightly, so allow 1 point.
    { ok: !!paper && !!spy && equityRows.length >= 60 && paper.totalReturnPct >= spy.totalReturnPct - 1 && riskAdj(paper) >= riskAdj(spy) - 0.05, label: "Paper results level with or better than the index", detail: paper && spy ? `Paper ${pct(paper.totalReturnPct)} vs SPY ${pct(spy.totalReturnPct)} since ${first}. Within 1 point counts as level.` : "Needs paper history." },
    { ok: !!paper && equityRows.length >= 60 && paper.maxDrawdownPct <= 20, label: "Worst paper fall under 20%", detail: paper ? `Worst fall so far −${paper.maxDrawdownPct.toFixed(1)}%.` : "Needs paper history." },
    { ok: avgGap !== null && filled.length >= 5 && avgGap <= 0.3, label: "Fills close to the prices the model expected", detail: avgGap === null ? "No fills yet." : `Average gap ${avgGap.toFixed(2)}% over ${filled.length} fills.` },
    { ok: !!latest && riskAdj(latest.meta.loop) >= riskAdj(latest.meta.index) - 0.02, label: "The loop did at least as well as the index in its own historical self-test", detail: latest ? `Loop ${pct(latest.meta.loop.cagrPct)}/yr vs index ${pct(latest.meta.index.cagrPct)}/yr since ${latest.meta.from.slice(0, 4)}.` : "Run research first." },
    { ok: false, label: "Your decision, with a broker that serves South African residents", detail: "Never automatic. Even with every item green, live trading starts only when you choose it." },
  ];
  const ready = checks.slice(0, 5).every((c) => c.ok);

  return (
    <Shell>
      {msg && <div className="rounded border border-accent bg-accent-soft px-4 py-3 text-sm text-accent">{msg}</div>}

      <Card title="How the loop works">
        <ol className="grid gap-3 text-sm sm:grid-cols-4">
          <li className="rounded bg-bg p-3"><div className="font-medium">1. Re-test monthly</div><p className="mt-1 text-muted">After each month&apos;s last close, every rule set on the menu ({latest?.configsTested ?? "about 60"}) is re-run on the latest three years.</p></li>
          <li className="rounded bg-bg p-3"><div className="font-medium">2. Pick a champion</div><p className="mt-1 text-muted">Holding the S&amp;P 500 is the default. A rule set only takes over by beating it on return per unit of risk by more than luck could explain.</p></li>
          <li className="rounded bg-bg p-3"><div className="font-medium">3. Paper trade it</div><p className="mt-1 text-muted">The account moves to the champion&apos;s holdings at the next open, automatically, on Alpaca paper.</p></li>
          <li className="rounded bg-bg p-3"><div className="font-medium">4. Earn live</div><p className="mt-1 text-muted">A checklist tracks whether the paper record justifies real money. Going live is always your call.</p></li>
        </ol>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Now" aside={<Pill tone={state.status === "paper" ? "up" : "muted"}>{state.status === "paper" ? "paper trading" : "off"}</Pill>}>
          <div className="text-xs font-medium uppercase tracking-wide text-muted">Champion</div>
          <div className="mt-1 font-medium">{champ?.label ?? "Not chosen yet"}</div>
          {state.championReason && <p className="mt-1 text-sm text-muted">{state.championReason}</p>}
          {latest && (
            <p className="mt-2 text-sm">
              Target: {Object.keys(latest.target).length === 0 ? "all cash" : Object.entries(latest.target).map(([s, w]) => `${s} ${(w * 100).toFixed(0)}%`).join(", ")}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-3">
            {state.status === "paper" ? (
              <form action={pauseAction}><button className="rounded border border-line px-3 py-1.5 text-xs" type="submit">Pause paper trading</button></form>
            ) : (
              <form action={startAction} className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2">
                  <input id="confirm-start" type="checkbox" name="confirm" value="yes" required />
                  Trade {usd(settings.accountUsd, 0)} ({zar(settings.accountUsd, settings.zarPerUsd)}) on paper, automatically
                </label>
                <button className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white" type="submit">{state.startedAt ? "Resume" : "Start paper trading"}</button>
              </form>
            )}
            <form action={researchAction}><button className="rounded border border-line px-3 py-1.5 text-xs" type="submit">Re-test now</button></form>
          </div>
        </Card>

        <Card title="Paper account">
          {!state.startedAt ? (
            <Empty>Not started. Once on, the value is recorded after every US close and compared with simply holding SPY from the same day.</Empty>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-4">
                <Stat label="Value" value={usd(equityRows.at(-1)?.equity ?? state.startEquity ?? 0, 0)} sub={zar(equityRows.at(-1)?.equity ?? state.startEquity ?? 0, settings.zarPerUsd)} />
                <Stat label="Since start" value={paper ? pct(paper.totalReturnPct) : "–"} sub={`from ${state.startedAt}`} />
                <Stat label="SPY same days" value={spy ? pct(spy.totalReturnPct) : "–"} />
              </div>
              <div className="mt-4 text-sm">
                <div className="text-xs font-medium uppercase tracking-wide text-muted">Holdings</div>
                <p className="mt-1">{holdings.length ? holdings.map((h) => `${h.symbol} × ${h.shares}`).join(", ") : "Cash"} · cash {usd(state.cash, 0)}</p>
                {openOrders.length > 0 && <p className="mt-1 text-muted">{openOrders.length} order{openOrders.length > 1 ? "s" : ""} waiting for the next open: {openOrders.map((o) => `${o.side} ${o.qty} ${o.symbol}`).join(", ")}</p>}
              </div>
            </>
          )}
        </Card>
      </div>

      <Card title="Ready for real money?" aside={<Pill tone={ready ? "up" : "warn"}>{ready ? "Paper record qualifies" : "Not yet"}</Pill>}>
        <ul className="space-y-2.5">
          {checks.map((c) => (
            <li key={c.label} className="flex items-start gap-3 text-sm">
              <span className={`mt-0.5 inline-block h-4 w-4 shrink-0 rounded-full border-2 ${c.ok ? "border-up bg-up" : "border-line"}`} aria-hidden="true" />
              <div><div className="font-medium">{c.label}</div><div className="text-muted">{c.detail}</div></div>
            </li>
          ))}
        </ul>
      </Card>

      {latest ? (
        <>
          {!latest.requiredMargin && (
            <div className="rounded border border-warn bg-warn-soft px-4 py-3 text-sm text-warn">
              These results use the old selection rule, which let lucky rule sets take over. Press Re-test now to see the corrected loop.
            </div>
          )}
          <Card title="Would this loop have beaten the index?">
            <p className="text-sm text-muted">
              The loop replayed month by month from {latest.meta.from} to {latest.meta.to}, choosing each month with only the data it would have had then.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr><th className="py-1 pr-3" /><th className="py-1 pr-3">Per year</th><th className="py-1 pr-3">Worst fall</th><th className="py-1 pr-3">Volatility</th><th className="py-1 pr-3">Return per unit of risk</th><th className="py-1">Total</th></tr>
                </thead>
                <tbody>
                  {([["The loop", latest.meta.loop], ["Hold SPY", latest.meta.index]] as const).map(([label, m]) => (
                    <tr key={label} className="border-t border-line">
                      <td className="py-2 pr-3 font-medium">{label}</td>
                      <td className="num py-2 pr-3">{pct(m.cagrPct)}</td>
                      <td className="num py-2 pr-3">−{m.maxDrawdownPct.toFixed(1)}%</td>
                      <td className="num py-2 pr-3">{m.volPct.toFixed(1)}%</td>
                      <td className="num py-2 pr-3">{riskAdj(m).toFixed(2)}</td>
                      <td className="num py-2">{pct(m.totalReturnPct, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <MetaChart loop={latest.meta.loopCurve} index={latest.meta.indexCurve} />
            <p className="mt-3 text-sm">
              It switched champion {latest.meta.switches} times and held the index {latest.meta.timeInIndexPct.toFixed(0)}% of the time.
              {" "}Champions it chose: {latest.meta.history.map((h) => `${h.date.slice(0, 7)} ${configById(h.id)?.label ?? h.id}`).join(" → ")}.
            </p>
            <p className="mt-2 text-xs text-muted">
              Honest limit: the menu was chosen in October 2026 after seeing how these kinds of rules did since 2017, so this replay is somewhat optimistic.
              Only the paper record from today onward is truly unseen.
            </p>
          </Card>

          <Card title={`Leaderboard: last three years to ${latest.asOf}`}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr><th className="py-1 pr-3">Rule set</th><th className="py-1 pr-3">Type</th><th className="py-1 pr-3">Risk-adjusted</th><th className="py-1 pr-3">Per year</th><th className="py-1">Worst fall</th></tr>
                </thead>
                <tbody>
                  {latest.leaderboard.map((r) => (
                    <tr key={r.id} className={`border-t border-line ${r.id === latest.champion.id ? "bg-accent-soft" : ""}`}>
                      <td className="py-2 pr-3">{r.label}{r.id === latest.champion.id && <span className="ml-2"><Pill tone="accent">champion</Pill></span>}{r.id === BASELINE_ID && <span className="ml-2"><Pill tone="muted">index</Pill></span>}</td>
                      <td className="py-2 pr-3 text-muted">{FAMILY_LABEL[r.family as Family]}</td>
                      <td className="num py-2 pr-3">{r.sharpe.toFixed(2)} <span className="text-xs text-muted">{r.id !== BASELINE_ID ? `(${r.sharpe - latest.baselineSharpe >= 0 ? "+" : ""}${(r.sharpe - latest.baselineSharpe).toFixed(2)} vs index)` : ""}</span></td>
                      <td className="num py-2 pr-3">{pct(r.cagrPct)}</td>
                      <td className="num py-2">−{r.maxDrawdownPct.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-muted">
              {latest.requiredMargin
                ? `A challenger must beat the index by more than ${latest.requiredMargin.toFixed(2)} to become champion. That is how far the best of ${latest.configsTested} rule sets can get ahead by luck alone over three years.`
                : "This run used the old +0.10 bar, which was too easy to clear by luck. Re-test to apply the corrected bar."}
            </p>
          </Card>
        </>
      ) : (
        <Card><Empty>No research yet. Press Re-test now, or start paper trading, which re-tests first.</Empty></Card>
      )}

      {research.length > 0 && (
        <Card title="Research log">
          <ul className="space-y-1 text-sm">
            {research.map((r) => {
              const x = r.results as ResearchResults;
              const changed = x.previousChampion && x.previousChampion !== x.champion.id;
              return (
                <li key={r.id} className="num text-muted">
                  {r.createdAt.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", dateStyle: "medium", timeStyle: "short" })} · data to {x.asOf} · {x.configsTested} rule sets ·{" "}
                  <span className={changed ? "text-accent" : ""}>{changed ? "new champion: " : "champion: "}{x.champion.label}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </Shell>
  );
}

function MetaChart({ loop, index }: { loop: { date: string; value: number }[]; index: { date: string; value: number }[] }) {
  if (loop.length < 2 || index.length < 2) return null;
  const W = 640, H = 200, L = 44, R = 10, T = 10, B = 24;
  const t0 = Date.parse(loop[0].date), t1 = Date.parse(loop[loop.length - 1].date);
  const vals = [...loop, ...index].map((p) => p.value);
  const lo = Math.min(...vals) * 0.97, hi = Math.max(...vals) * 1.03;
  const x = (d: string) => L + ((Date.parse(d) - t0) / Math.max(t1 - t0, 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const path = (pts: { date: string; value: number }[]) => pts.map((p, k) => `${k ? "L" : "M"}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const years: string[] = [];
  for (let yr = Number(loop[0].date.slice(0, 4)) + 1; yr <= Number(loop[loop.length - 1].date.slice(0, 4)); yr++) years.push(`${yr}-01-01`);
  return (
    <div className="mt-4 overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full min-w-[480px]" role="img" aria-label="Growth of 100: the loop against holding SPY">
        {[0.2, 0.5, 0.8].map((f) => { const v = lo + (hi - lo) * f; return (
          <g key={f}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--line)" /><text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize={10.5} fill="var(--muted)">{v.toFixed(0)}</text></g>
        ); })}
        {years.map((d) => <text key={d} x={x(d)} y={H - 7} textAnchor="middle" fontSize={10.5} fill="var(--muted)">{d.slice(0, 4)}</text>)}
        <path d={path(index)} fill="none" stroke="var(--muted)" strokeWidth={1.5} />
        <path d={path(loop)} fill="none" stroke="var(--accent)" strokeWidth={2} />
      </svg>
      <div className="mt-1 flex gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4" style={{ background: "var(--accent)" }} />The loop, growth of 100</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4" style={{ background: "var(--muted)" }} />Hold SPY</span>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Learning loop</h1>
        <p className="mt-1 text-sm text-muted">Re-tests its menu every month, paper trades whatever is working, and keeps score until the record earns real money.</p>
      </div>
      {children}
    </div>
  );
}
