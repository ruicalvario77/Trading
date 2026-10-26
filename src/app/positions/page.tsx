import { desc, inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { ensureSchema } from "@/lib/db/migrate";
import { alpacaConfigured } from "@/lib/alpaca";
import { Card, Pill, Empty, usd } from "@/components/ui";
import { syncNow } from "./actions";

export const dynamic = "force-dynamic";

type Trade = typeof schema.trades.$inferSelect;
const fmt = (d: Date | null) => (d ? d.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", dateStyle: "short", timeStyle: "short" }) : "–");

export default async function Positions({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const db = getDb();
  if (!db) return <Shell><Empty>Database not connected.</Empty></Shell>;
  let live: Trade[] = [];
  let recent: Trade[] = [];
  try {
    await ensureSchema();
    live = await db.select().from(schema.trades).where(inArray(schema.trades.status, ["pending_entry", "open"])).orderBy(desc(schema.trades.id));
    recent = await db.select().from(schema.trades).where(inArray(schema.trades.status, ["closed", "cancelled"])).orderBy(desc(schema.trades.updatedAt)).limit(20);
  } catch (e) {
    return <Shell><p className="text-sm text-down">{e instanceof Error ? e.message : String(e)}</p></Shell>;
  }
  const openRisk = live.reduce((s, t) => s + t.riskUsd, 0);

  return (
    <Shell>
      {msg && <div className="rounded border border-accent bg-accent-soft px-4 py-3 text-sm text-accent">{msg}</div>}
      <Card
        title="Live"
        aside={alpacaConfigured() ? (
          <form action={syncNow}><button type="submit" className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white">Sync with broker</button></form>
        ) : null}
      >
        {live.length === 0 ? (
          <Empty>No pending entries or open positions. Approve a tradeable candidate and the pre-open job places it.</Empty>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted">Total risk if every stop is hit: <span className="num">{usd(openRisk)}</span></p>
            <TradeTable rows={live} live />
          </>
        )}
      </Card>
      <Card title="Recently closed or cancelled">
        {recent.length === 0 ? <Empty>Nothing yet.</Empty> : <TradeTable rows={recent} />}
      </Card>
      <p className="text-xs text-muted">Fills are synced at both daily jobs and whenever you press Sync. Entries that have not triggered within 3 days are cancelled.</p>
    </Shell>
  );
}

function TradeTable({ rows, live }: { rows: Trade[]; live?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="py-1 pr-3">Symbol</th><th className="py-1 pr-3">Status</th><th className="py-1 pr-3">Shares</th>
            <th className="py-1 pr-3">Entry</th><th className="py-1 pr-3">Stop</th><th className="py-1 pr-3">Target</th>
            {live ? <th className="py-1 pr-3">Risk</th> : <><th className="py-1 pr-3">Exit</th><th className="py-1 pr-3">Result</th></>}
            <th className="py-1">{live ? "Placed" : "Closed"} (SAST)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className="border-t border-line align-top">
              <td className="num py-2 pr-3 font-medium">{t.symbol}</td>
              <td className="py-2 pr-3">
                <Pill tone={t.status === "open" ? "accent" : t.status === "pending_entry" ? "warn" : t.status === "closed" ? (t.pnlUsd ?? 0) >= 0 ? "up" : "down" : "muted"}>
                  {t.status === "pending_entry" ? "waiting for entry" : t.status}{t.exitReason ? ` · ${t.exitReason.replace("_", " ")}` : ""}
                </Pill>
              </td>
              <td className="num py-2 pr-3">{t.shares}</td>
              <td className="num py-2 pr-3">{usd(t.entryFill ?? t.plannedEntry)}{t.entryFill === null && <span className="text-xs text-muted"> plan</span>}</td>
              <td className="num py-2 pr-3 text-down">{usd(t.currentStop)}</td>
              <td className="num py-2 pr-3 text-up">{usd(t.plannedTarget)}</td>
              {live ? (
                <td className="num py-2 pr-3">{usd(t.riskUsd)}</td>
              ) : (
                <>
                  <td className="num py-2 pr-3">{usd(t.exitFill)}</td>
                  <td className={`num py-2 pr-3 ${(t.pnlUsd ?? 0) >= 0 ? "text-up" : "text-down"}`}>
                    {t.pnlUsd === null ? "–" : `${usd(t.pnlUsd)} · ${t.rMultiple?.toFixed(2)}R`}
                  </td>
                </>
              )}
              <td className="num py-2 whitespace-nowrap">{fmt(live ? t.createdAt : t.exitedAt ?? t.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Positions</h1>
        <p className="mt-1 text-sm text-muted">Bracket orders at the paper broker, from trigger to exit.</p>
      </div>
      {children}
    </div>
  );
}
