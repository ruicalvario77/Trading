import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { ensureSchema } from "@/lib/db/migrate";
import { SETUPS, setupById } from "@/lib/setups/library";
import { setupStatuses, type Stage } from "@/lib/setups/paper";
import { Card, Empty, Pill, usd } from "@/components/ui";

export const dynamic = "force-dynamic";

const STAGE: Record<Stage, { tone: "up" | "down" | "warn" | "muted"; label: string }> = {
  research: { tone: "muted", label: "not tested" },
  failed: { tone: "down", label: "failed backtest, tracked only" },
  forward: { tone: "warn", label: "forward testing" },
  paper: { tone: "up", label: "paper trading" },
};

export default async function Signals() {
  const db = getDb();
  if (!db) return <Shell><Empty>Database not connected.</Empty></Shell>;
  await ensureSchema();
  const [latest] = await db.select({ d: sql<string | null>`max(${schema.shadowSignals.signalDate})` }).from(schema.shadowSignals);
  if (!latest?.d) return <Shell><Empty>No signals recorded yet. The nightly job records every setup&apos;s signals after the US close, once the universe and its history are loaded.</Empty></Shell>;
  const [rows, queued, { statuses }] = await Promise.all([
    db.select().from(schema.shadowSignals).where(eq(schema.shadowSignals.signalDate, latest.d)).orderBy(desc(schema.shadowSignals.score)),
    db.select().from(schema.candidates).where(and(eq(schema.candidates.tradeDate, latest.d), sql`${schema.candidates.setup} is not null`)),
    setupStatuses(db),
  ]);
  const queuedSet = new Map(queued.map((q) => [`${q.setup}:${q.symbol}`, q]));

  return (
    <Shell>
      <Card title={`Signals after the close of ${latest.d}`}>
        <p className="text-sm text-muted">
          {rows.length} signal{rows.length === 1 ? "" : "s"} from {SETUPS.length} setups across the market. Every one is recorded and followed forward with its rules.
          {" "}Only setups at the paper-trading stage place orders; {queued.length} order{queued.length === 1 ? " is" : "s are"} queued for the next open.
        </p>
      </Card>
      {SETUPS.map((s) => {
        const mine = rows.filter((r) => r.setup === s.id);
        const st = statuses.find((x) => x.id === s.id)!;
        return (
          <Card key={s.id} title={`${s.name} · ${mine.length}`} aside={<Pill tone={STAGE[st.stage].tone}>{STAGE[st.stage].label}</Pill>}>
            {mine.length === 0 ? (
              <Empty>No signal tonight.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted">
                    <tr><th className="py-1 pr-3">Symbol</th><th className="py-1 pr-3">Buy</th><th className="py-1 pr-3">Stop</th><th className="py-1 pr-3">Target</th><th className="py-1 pr-3">Why</th><th className="py-1">Order</th></tr>
                  </thead>
                  <tbody>
                    {mine.slice(0, 25).map((r) => {
                      const p = r.plan as { entryType: string; entry: number; stop: number; targetR: number | null };
                      const risk = p.entry - p.stop;
                      const q = queuedSet.get(`${s.id}:${r.symbol}`);
                      return (
                        <tr key={r.id} className="border-t border-line align-top">
                          <td className="num py-2 pr-3 font-medium">{r.symbol}</td>
                          <td className="num py-2 pr-3">{p.entryType === "open" ? "next open" : `above ${usd(p.entry)}`}</td>
                          <td className="num py-2 pr-3 text-down">{usd(p.stop)} <span className="text-xs text-muted">{((risk / p.entry) * 100).toFixed(1)}%</span></td>
                          <td className="num py-2 pr-3 text-up">{p.targetR === null ? setupById(s.id)?.id === "oversold" ? "first strong close" : "none" : usd(p.entry + p.targetR * risk)}</td>
                          <td className="max-w-sm py-2 pr-3 text-xs text-muted">{r.why}</td>
                          <td className="py-2">{q ? <Pill tone="accent">{q.shares} sh · {q.status}</Pill> : <span className="text-xs text-muted">tracked</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {mine.length > 25 && <p className="mt-2 text-xs text-muted">Showing the top 25 by the setup&apos;s own ranking. All {mine.length} are tracked.</p>}
              </div>
            )}
          </Card>
        );
      })}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Signals</h1>
        <p className="mt-1 text-sm text-muted">Tonight&apos;s signals from every setup, across the whole market.</p>
      </div>
      {children}
    </div>
  );
}
