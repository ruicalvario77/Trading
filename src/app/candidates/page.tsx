import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { ensureSchema } from "@/lib/db/migrate";
import { Card, Pill, Empty, usd } from "@/components/ui";
import { approveCandidate, setCandidateStatus } from "./actions";
import { PULLBACK_APPROVALS_PAUSED, PULLBACK_PAUSE_REASON } from "@/lib/strategy/status";

const STATUS_TONE: Record<string, "up" | "down" | "warn" | "accent" | "muted"> = {
  approved: "accent", ordered: "up", rejected: "muted", expired: "muted", blocked: "warn", failed: "down",
};

export const dynamic = "force-dynamic";

export default async function Candidates({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const db = getDb();
  if (!db) return <Shell><Empty>Database not connected.</Empty></Shell>;

  let scan: typeof schema.scans.$inferSelect | undefined;
  let rows: (typeof schema.candidates.$inferSelect)[] = [];
  try {
    await ensureSchema();
    [scan] = await db.select().from(schema.scans).orderBy(desc(schema.scans.id)).limit(1);
    if (scan) rows = await db.select().from(schema.candidates).where(eq(schema.candidates.scanId, scan.id)).orderBy(desc(schema.candidates.tradeable), desc(schema.candidates.score));
  } catch (e) {
    return <Shell><p className="text-sm text-down">{e instanceof Error ? e.message : String(e)}</p></Shell>;
  }
  if (!scan) return <Shell><Empty>No scan has run yet. Run the after-close job from the overview page.</Empty></Shell>;

  return (
    <Shell>
      {msg && <div className="rounded border border-accent bg-accent-soft px-4 py-3 text-sm text-accent">{msg === "not-approvable" ? "That candidate can no longer be approved." : msg}</div>}
      {PULLBACK_APPROVALS_PAUSED && <div className="rounded border border-warn bg-warn-soft px-4 py-3 text-sm text-warn">{PULLBACK_PAUSE_REASON}</div>}
      <Card title={`Scan for ${scan.tradeDate}`}>
        <p className="text-sm text-muted">
          {scan.universeSize} symbols in the universe, {scan.withEnoughHistory} with enough history, {scan.passedFilters} matched the pullback setup,{" "}
          {rows.filter((r) => r.tradeable).length} fit the account rules.
        </p>
      </Card>
      {rows.length === 0 ? (
        <Empty>Nothing matched tonight. That is a normal result.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2">Symbol</th><th className="px-3 py-2">Close</th><th className="px-3 py-2">Entry</th><th className="px-3 py-2">Stop</th>
                <th className="px-3 py-2">Target</th><th className="px-3 py-2">Shares</th><th className="px-3 py-2">Risk</th><th className="px-3 py-2">Position</th><th className="px-3 py-2">Fit</th><th className="px-3 py-2">Decision</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-t border-line align-top">
                  <td className="px-3 py-2">
                    <div className="num font-medium">{c.symbol}</div>
                    {c.why && <div className="mt-1 max-w-xs text-xs text-muted">{c.why}</div>}
                  </td>
                  <td className="num px-3 py-2">{usd(c.close)}</td>
                  <td className="num px-3 py-2">{usd(c.entry)}</td>
                  <td className="num px-3 py-2 text-down">{usd(c.stop)}</td>
                  <td className="num px-3 py-2 text-up">{usd(c.target)}</td>
                  <td className="num px-3 py-2">{c.shares ?? "–"}</td>
                  <td className="num px-3 py-2">{usd(c.riskUsd)}</td>
                  <td className="num px-3 py-2">{usd(c.positionUsd, 0)}</td>
                  <td className="px-3 py-2">
                    {c.tradeable ? <Pill tone="up">tradeable</Pill> : (
                      <div className="space-y-1">
                        <Pill tone="warn">rejected</Pill>
                        <ul className="text-xs text-muted">{c.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {c.status === "new" && c.tradeable && PULLBACK_APPROVALS_PAUSED ? (
                      <span className="text-xs text-muted">paused</span>
                    ) : c.status === "new" && c.tradeable ? (
                      <div className="flex gap-2">
                        <form action={approveCandidate}>
                          <input type="hidden" name="id" value={c.id} />
                          <button type="submit" className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-white">Approve</button>
                        </form>
                        <form action={setCandidateStatus}>
                          <input type="hidden" name="id" value={c.id} />
                          <input type="hidden" name="to" value="rejected" />
                          <button type="submit" className="rounded border border-line px-2.5 py-1 text-xs text-muted">Skip</button>
                        </form>
                      </div>
                    ) : c.status === "approved" ? (
                      <div className="flex items-center gap-2">
                        <Pill tone="accent">approved</Pill>
                        <form action={setCandidateStatus}>
                          <input type="hidden" name="id" value={c.id} />
                          <input type="hidden" name="to" value="new" />
                          <button type="submit" className="text-xs text-muted underline">undo</button>
                        </form>
                      </div>
                    ) : c.status !== "new" ? (
                      <Pill tone={STATUS_TONE[c.status] ?? "muted"}>{c.status}</Pill>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted">Approved setups are sent as bracket orders to the paper account by the pre-open job at 15:00 SAST on weekdays. Unapproved setups expire at the next scan.</p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Candidates</h1>
        <p className="mt-1 text-sm text-muted">The latest pullback setups, planned and sized to the account rules.</p>
      </div>
      {children}
    </div>
  );
}
