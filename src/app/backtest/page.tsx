import { desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { ensureSchema } from "@/lib/db/migrate";
import { loadSettings, zar } from "@/lib/settings";
import { HISTORY_START } from "@/lib/jobs/backfill";
import type { BacktestResults, VariantResult } from "@/lib/backtest/run";
import { Card, Pill, Empty, Stat, usd } from "@/components/ui";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const pct = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;
const rr = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`;
const SERIES = ["var(--accent)", "var(--up)", "var(--warn)"];

function verdict(v: VariantResult): { tone: "up" | "down" | "warn" | "muted"; text: string; detail: string } {
  if (v.edge.trades < 30) return { tone: "muted", text: "Too few trades", detail: "Fewer than 30 trades is not enough to judge anything." };
  if (v.edge.expectancyR <= 0) return { tone: "down", text: "No edge", detail: "On average each trade lost money after costs." };
  if (v.earlier.expectancyR > 0 && v.later.expectancyR > 0 && v.edge.expectancyR >= 0.1)
    return { tone: "up", text: "Positive in both halves", detail: "Made money on average in the earlier and the later half of the period." };
  return { tone: "warn", text: "Weak or inconsistent", detail: "Slightly positive overall, but small or not holding up across both halves." };
}

export default async function BacktestPage({ searchParams }: { searchParams: Promise<{ run?: string; msg?: string }> }) {
  const { run, msg } = await searchParams;
  const db = getDb();
  if (!db) return <Shell><Empty>Database not connected.</Empty></Shell>;
  await ensureSchema();

  const [[cov], [bf], [sy], runs, settings] = await Promise.all([
    db.select({ bars: sql<number>`count(*)::int`, earliest: sql<string | null>`min(${schema.bars.date})` }).from(schema.bars),
    db.select({ n: sql<number>`count(*)::int`, earliest: sql<string | null>`min(${schema.backfills.earliest})` }).from(schema.backfills),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.symbols).where(eq(schema.symbols.active, true)),
    db.select({ id: schema.backtestRuns.id, createdAt: schema.backtestRuns.createdAt, params: schema.backtestRuns.params }).from(schema.backtestRuns).orderBy(desc(schema.backtestRuns.id)).limit(8),
    loadSettings(),
  ]);
  const selectedId = run ? Number(run) : runs[0]?.id;
  const [sel] = selectedId ? await db.select().from(schema.backtestRuns).where(eq(schema.backtestRuns.id, selectedId)).limit(1) : [];
  const historyDone = sy.n > 0 && bf.n >= sy.n;
  const thisYear = new Date().getUTCFullYear();
  const years = Array.from({ length: thisYear - 2016 }, (_, k) => 2016 + k);

  return (
    <Shell>
      {msg && <div className="rounded border border-accent bg-accent-soft px-4 py-3 text-sm text-accent">{msg}</div>}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="1. Price history">
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Daily bars" value={cov.bars.toLocaleString()} />
            <Stat label="Earliest" value={<span className="text-base">{cov.earliest ?? "none"}</span>} />
            <Stat label="Symbols loaded" value={<span className="text-base">{bf.n} / {sy.n}</span>} />
          </div>
          <p className="mt-3 text-sm text-muted">
            The backtest needs years of daily prices. Loading pulls full-market history back to {HISTORY_START.slice(0, 4)} for every symbol.
            It takes a few minutes and may need two or three presses.
          </p>
          <form action="/api/backfill" method="post" className="mt-3">
            <button type="submit" disabled={historyDone} className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
              {historyDone ? "History loaded" : bf.n > 0 ? "Continue loading history" : "Load history"}
            </button>
          </form>
        </Card>

        <Card title="2. Run a backtest">
          <p className="text-sm text-muted">
            Replays the exact scanner and planner the live system uses, day by day, on every symbol, with your current settings:
            {" "}{usd(settings.accountUsd, 0)} ({zar(settings.accountUsd, settings.zarPerUsd)}), {settings.riskPct}% risk, up to {settings.maxPositions} positions.
            Three ways of managing the trade are tested side by side. Takes about a minute.
          </p>
          <form action="/api/backtest" method="post" className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="block text-xs text-muted">Start year</span>
              <select id="startYear" name="startYear" defaultValue="2016" className="mt-1 rounded border border-line bg-bg px-2 py-1.5">
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </label>
            <button type="submit" disabled={cov.bars === 0} className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">Run backtest</button>
          </form>
          {!historyDone && <p className="mt-2 text-xs text-warn">History is not fully loaded yet. Load it first, or the results will cover too short a period.</p>}
        </Card>
      </div>

      {runs.length > 1 && (
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="text-muted">Earlier runs:</span>
          {runs.map((r) => (
            <a key={r.id} href={`/backtest?run=${r.id}`} className={`rounded border px-2 py-0.5 ${r.id === selectedId ? "border-accent text-accent" : "border-line text-muted"}`}>
              #{r.id} · from {String((r.params as { startYear?: number }).startYear ?? "?")} · {r.createdAt.toLocaleDateString("en-ZA")}
            </a>
          ))}
        </div>
      )}

      {sel ? <Results r={sel.results as BacktestResults} id={sel.id} /> : <Card><Empty>No backtest yet. Load history, then run one.</Empty></Card>}
    </Shell>
  );
}

function Results({ r, id }: { r: BacktestResults; id: number }) {
  const best = [...r.variants].sort((a, b) => b.edge.expectancyR - a.edge.expectancyR)[0];
  return (
    <div className="space-y-6">
      {!r.feed && (
        <div className="rounded border border-warn bg-warn-soft px-4 py-3 text-sm text-warn">
          This run used the old single-exchange data, which for most symbols only starts in mid-2020. Run the backtest again for full-market results back to 2016.
        </div>
      )}
      <Card title={`Run #${id}: ${r.firstDate} to ${r.lastDate}`} aside={<span className="text-xs text-muted">{r.years.toFixed(1)} years · {r.symbolsWithData} symbols</span>}>
        <div className="grid gap-3 md:grid-cols-3">
          {r.variants.map((v, k) => {
            const vd = verdict(v);
            return (
              <div key={v.variant} className="rounded border border-line p-3">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SERIES[k] }} />
                  <Pill tone={vd.tone}>{vd.text}</Pill>
                </div>
                <div className="mt-2 text-sm font-medium">{v.label}</div>
                <div className="num mt-2 text-2xl">{rr(v.edge.expectancyR)}</div>
                <div className="text-xs text-muted">average per trade, over {v.edge.trades.toLocaleString()} trades</div>
                <p className="mt-2 text-xs text-muted">{vd.detail}</p>
              </div>
            );
          })}
        </div>
        <p className="mt-4 text-sm">
          <span className="font-medium">How to read this.</span> R is one unit of risk: the amount lost if the original stop is hit.
          {" "}+0.10R per trade means that, risking {zar((r.accountUsd * r.assumptions.riskPct) / 100, r.zarPerUsd)} a trade, you would make about
          {" "}{zar((r.accountUsd * r.assumptions.riskPct) / 1000, r.zarPerUsd)} per trade on average. Anything at or below zero is no edge.
          Best of the three here: <span className="font-medium">{best.label.toLowerCase()}</span>.
        </p>
      </Card>

      <Card title="Edge per trade, independent of account size">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1 pr-3">Management</th><th className="py-1 pr-3">Trades</th><th className="py-1 pr-3">Win rate</th>
                <th className="py-1 pr-3">Avg win</th><th className="py-1 pr-3">Avg loss</th><th className="py-1 pr-3">Expectancy</th>
                <th className="py-1 pr-3">Profit factor</th><th className="py-1 pr-3">Worst losing streak</th>
                <th className="py-1 pr-3">Before {r.midDate.slice(0, 7)}</th><th className="py-1">After</th>
              </tr>
            </thead>
            <tbody>
              {r.variants.map((v) => (
                <tr key={v.variant} className="border-t border-line">
                  <td className="py-2 pr-3">{v.variant}</td>
                  <td className="num py-2 pr-3">{v.edge.trades.toLocaleString()}</td>
                  <td className="num py-2 pr-3">{(v.edge.winRate * 100).toFixed(0)}%</td>
                  <td className="num py-2 pr-3 text-up">{rr(v.edge.avgWinR)}</td>
                  <td className="num py-2 pr-3 text-down">{rr(v.edge.avgLossR)}</td>
                  <td className={`num py-2 pr-3 ${v.edge.expectancyR > 0 ? "text-up" : "text-down"}`}>{rr(v.edge.expectancyR)}</td>
                  <td className="num py-2 pr-3">{v.edge.profitFactor?.toFixed(2) ?? "–"}</td>
                  <td className="num py-2 pr-3">{v.edge.maxLosingStreak}</td>
                  <td className="num py-2 pr-3">{rr(v.earlier.expectancyR)} <span className="text-xs text-muted">({v.earlier.trades})</span></td>
                  <td className="num py-2">{rr(v.later.expectancyR)} <span className="text-xs text-muted">({v.later.trades})</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">
          Every setup the scanner found that passed the planner and triggered, with {r.assumptions.slippagePct}% slippage on each side.
          Splitting the period in half checks whether the result depends on one lucky stretch.
        </p>
      </Card>

      <Card title="Account results under your rules">
        <EquityChart variants={r.variants} first={r.firstDate} last={r.lastDate} />
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1 pr-3">Management</th><th className="py-1 pr-3">Start</th><th className="py-1 pr-3">End</th>
                <th className="py-1 pr-3">Per year</th><th className="py-1 pr-3">Worst drawdown</th><th className="py-1 pr-3">Trades taken</th><th className="py-1">Skipped</th>
              </tr>
            </thead>
            <tbody>
              {r.variants.flatMap((v) =>
                ([["main", v.main], ["small", v.small]] as const).map(([kind, p]) => (
                  <tr key={`${v.variant}-${kind}`} className="border-t border-line">
                    <td className="py-2 pr-3">{v.variant} <span className="text-xs text-muted">{kind === "small" ? "· R10,000" : `· ${zar(r.accountUsd, r.zarPerUsd)}`}</span></td>
                    <td className="num py-2 pr-3">{usd(p.startEquity, 0)}</td>
                    <td className="num py-2 pr-3">{usd(p.finalEquity, 0)} <span className="text-xs text-muted">{pct(p.totalReturnPct, 0)}</span></td>
                    <td className={`num py-2 pr-3 ${p.cagrPct > 0 ? "text-up" : "text-down"}`}>{pct(p.cagrPct)}</td>
                    <td className="num py-2 pr-3 text-down">{p.maxDrawdownPct > 0 ? `−${p.maxDrawdownPct.toFixed(1)}%` : "0%"}</td>
                    <td className="num py-2 pr-3">{p.taken}</td>
                    <td className="py-2 text-xs text-muted">
                      {p.skipped.maxPositions} at position limit · {p.skipped.tooSmall} too small for account{p.skipped.weeklyLimit ? ` · ${p.skipped.weeklyLimit} weekly limit` : ""}
                    </td>
                  </tr>
                )),
              )}
              {r.benchmark && (
                <tr className="border-t border-line">
                  <td className="py-2 pr-3">Buy and hold SPY</td><td className="py-2 pr-3" />
                  <td className="num py-2 pr-3 text-xs text-muted">{pct(r.benchmark.totalReturnPct, 0)}</td>
                  <td className="num py-2 pr-3">{pct(r.benchmark.cagrPct)}</td><td colSpan={3} className="py-2 text-xs text-muted">The bar to beat: what doing nothing clever earned.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">
          Sizing follows your settings: {r.assumptions.riskPct}% risk per trade, at most {r.assumptions.maxPositionPct}% of the account in one position,
          {" "}{r.assumptions.maxPositions} positions, no margin, {r.assumptions.weeklyLossLimitPct}% weekly loss limit. Drawdown counts closed trades only, so the real worst dip was somewhat deeper.
        </p>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Year by year">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr><th className="py-1 pr-3">Year</th>{r.variants.map((v) => <th key={v.variant} className="py-1 pr-3">{v.variant}</th>)}</tr>
              </thead>
              <tbody>
                {[...new Set(r.variants.flatMap((v) => v.perYear.map((y) => y.year)))].sort().map((year) => (
                  <tr key={year} className="border-t border-line">
                    <td className="num py-1.5 pr-3">{year}</td>
                    {r.variants.map((v) => {
                      const y = v.perYear.find((p) => p.year === year);
                      return <td key={v.variant} className={`num py-1.5 pr-3 ${!y ? "" : y.returnPct >= 0 ? "text-up" : "text-down"}`}>{y ? pct(y.returnPct) : "–"}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="How trades ended">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr><th className="py-1 pr-3">Exit</th>{r.variants.map((v) => <th key={v.variant} className="py-1 pr-3">{v.variant}</th>)}</tr>
              </thead>
              <tbody>
                {["target", "stop", "breakeven", "trail", "time", "end"].map((k) => (
                  <tr key={k} className="border-t border-line">
                    <td className="py-1.5 pr-3">{k === "end" ? "still open at end" : k}</td>
                    {r.variants.map((v) => <td key={v.variant} className="num py-1.5 pr-3">{v.exitReasons[k] ?? "–"}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 text-sm">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">Signal funnel</div>
            <p className="mt-1 text-muted">
              {r.funnel.signals.toLocaleString()} setups found. {Object.entries(r.funnel.rejected).map(([k, n]) => `${n.toLocaleString()} ${k}`).join(", ") || "None rejected"}.
              {" "}{r.funnel.unfilled.toLocaleString()} never triggered. {r.funnel.entered.toLocaleString()} entered.
            </p>
          </div>
        </Card>
      </div>

      <Card title={`Most recent trades · ${best.variant}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr><th className="py-1 pr-3">Symbol</th><th className="py-1 pr-3">In</th><th className="py-1 pr-3">Out</th><th className="py-1 pr-3">Shares</th><th className="py-1 pr-3">Exit</th><th className="py-1 pr-3">R</th><th className="py-1">P&amp;L</th></tr>
            </thead>
            <tbody>
              {best.recent.map((t, k) => (
                <tr key={k} className="border-t border-line">
                  <td className="num py-1.5 pr-3">{t.symbol}</td><td className="num py-1.5 pr-3">{t.entryDate}</td><td className="num py-1.5 pr-3">{t.exitDate}</td>
                  <td className="num py-1.5 pr-3">{t.shares}</td><td className="py-1.5 pr-3">{t.exitReason}</td>
                  <td className={`num py-1.5 pr-3 ${t.r >= 0 ? "text-up" : "text-down"}`}>{rr(t.r)}</td>
                  <td className={`num py-1.5 ${t.pnl >= 0 ? "text-up" : "text-down"}`}>{usd(t.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="What this cannot tell you">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>The universe is today&apos;s list of stocks. Companies that collapsed or were delisted since {r.firstDate.slice(0, 4)} are missing, which flatters the results.</li>
          <li>The settings were chosen before testing, which is good, but every change made after looking at these numbers makes the next result less trustworthy.</li>
          <li>Daily bars cannot show what happened inside the day. When a bar touches both the stop and the target, the test assumes the stop came first.</li>
          <li>It assumes every tradeable setup is approved. Skipping some by feel changes the result in ways no test can measure.</li>
        </ul>
      </Card>
    </div>
  );
}

function EquityChart({ variants, first, last }: { variants: VariantResult[]; first: string; last: string }) {
  const W = 640, H = 230, L = 58, R = 12, T = 12, B = 26;
  const t0 = Date.parse(first), t1 = Math.max(Date.parse(last), t0 + 1);
  const all = variants.flatMap((v) => v.curve.map((p) => p.equity));
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 1) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const x = (d: string) => L + ((Date.parse(d) - t0) / (t1 - t0)) * (W - L - R);
  const y = (e: number) => T + (1 - (e - lo) / (hi - lo)) * (H - T - B);
  const ticks = Array.from({ length: 4 }, (_, k) => lo + ((hi - lo) * (k + 0.5)) / 4);
  const yearTicks: string[] = [];
  for (let yr = Number(first.slice(0, 4)) + 1; yr <= Number(last.slice(0, 4)); yr++) yearTicks.push(`${yr}-01-01`);
  const step = Math.ceil(yearTicks.length / 8) || 1;
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full min-w-[520px]" role="img" aria-label="Account equity over time for each management style">
        {ticks.map((v, k) => (
          <g key={k}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize={10.5} fill="var(--muted)" className="num">${(v / 1000).toFixed(1)}k</text>
          </g>
        ))}
        {yearTicks.filter((_, k) => k % step === 0).map((d) => (
          <text key={d} x={x(d)} y={H - 8} textAnchor="middle" fontSize={10.5} fill="var(--muted)" className="num">{d.slice(0, 4)}</text>
        ))}
        {variants.map((v, k) => {
          const pts = v.curve;
          if (!pts.length) return null;
          let dpath = `M${x(pts[0].date).toFixed(1)},${y(pts[0].equity).toFixed(1)}`;
          for (const p of pts.slice(1)) dpath += `H${x(p.date).toFixed(1)}V${y(p.equity).toFixed(1)}`;
          dpath += `H${x(last).toFixed(1)}`;
          return <path key={v.variant} d={dpath} fill="none" stroke={SERIES[k]} strokeWidth={1.8} strokeLinejoin="round" />;
        })}
      </svg>
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted">
        {variants.map((v, k) => (
          <span key={v.variant} className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4" style={{ background: SERIES[k] }} />{v.variant}</span>
        ))}
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Backtest</h1>
        <p className="mt-1 text-sm text-muted">Does this setup have an edge? Years of history, the same rules, three ways to manage the trade.</p>
      </div>
      {children}
    </div>
  );
}
