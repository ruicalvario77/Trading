import { loadSettings, zar } from "@/lib/settings";
import { getDb } from "@/lib/db";
import { Card } from "@/components/ui";
import { updateSettings } from "./actions";

export const dynamic = "force-dynamic";

type Field = { name: string; label: string; step?: string; hint: string };

const groups: { title: string; fields: Field[] }[] = [
  {
    title: "Account",
    fields: [
      { name: "accountUsd", label: "Account size (USD)", step: "1", hint: "The capital you are sizing against. R10,000 is about $550." },
      { name: "zarPerUsd", label: "Rand per dollar", step: "0.01", hint: "Only used to show rand equivalents." },
    ],
  },
  {
    title: "Risk",
    fields: [
      { name: "riskPct", label: "Risk per trade (%)", step: "0.1", hint: "Dollars lost if the stop is hit, as a share of the account." },
      { name: "maxPositions", label: "Max open positions", step: "1", hint: "Pending entries count too." },
      { name: "weeklyLossLimitPct", label: "Weekly loss limit (%)", step: "0.5", hint: "No new entries for the rest of the week once reached." },
      { name: "maxPositionPct", label: "Max position size (% of account)", step: "1", hint: "Caps concentration. Small accounts need this high to take any trade." },
    ],
  },
  {
    title: "Universe and exits",
    fields: [
      { name: "minPrice", label: "Minimum price", step: "0.5", hint: "" },
      { name: "maxPrice", label: "Maximum price", step: "1", hint: "Lower prices let a small account buy whole shares." },
      { name: "minAvgVolume", label: "Minimum 20-day average volume", step: "100000", hint: "Shares traded per day across all US exchanges. Keeps out stocks where your orders could move the price." },
      { name: "targetR", label: "Target (multiple of risk)", step: "0.5", hint: "2 means winners are twice the size of losers." },
      { name: "timeStopDays", label: "Time stop (trading days)", step: "1", hint: "Exit at the close if neither stop nor target has hit." },
    ],
  },
];

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const { saved } = await searchParams;
  const s = await loadSettings();
  const values = s as unknown as Record<string, number>;
  const hasDb = !!getDb();
  const riskUsd = (s.accountUsd * s.riskPct) / 100;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted">
          Current risk per trade: <span className="num">${riskUsd.toFixed(2)}</span> ({zar(riskUsd, s.zarPerUsd)}). Tighten any time. Loosen only on a weekend.
        </p>
      </div>
      {saved && <div className="rounded border border-up bg-up-soft px-4 py-3 text-sm text-up">Saved.</div>}
      {!hasDb && <div className="rounded border border-warn bg-warn-soft px-4 py-3 text-sm text-warn">Showing defaults. Connect the database to save changes.</div>}
      <form action={updateSettings} className="space-y-4">
        {groups.map((g) => (
          <Card key={g.title} title={g.title}>
            <div className="grid gap-4 sm:grid-cols-2">
              {g.fields.map((f) => (
                <label key={f.name} className="block text-sm">
                  <span>{f.label}</span>
                  <input id={f.name} name={f.name} type="number" step={f.step ?? "any"} defaultValue={values[f.name]} required
                    className="num mt-1 w-full rounded border border-line bg-bg px-3 py-2" />
                  {f.hint && <span className="mt-1 block text-xs text-muted">{f.hint}</span>}
                </label>
              ))}
            </div>
          </Card>
        ))}
        <button type="submit" disabled={!hasDb} className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Save settings</button>
      </form>
    </div>
  );
}
