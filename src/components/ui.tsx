import type { ReactNode } from "react";

export function Card({ title, children, aside }: { title?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-5">
      {(title || aside) && (
        <div className="mb-3 flex items-baseline justify-between gap-4">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="num mt-1 text-xl">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Pill({ tone, children }: { tone: "up" | "down" | "warn" | "accent" | "muted"; children: ReactNode }) {
  const cls = {
    up: "bg-up-soft text-up",
    down: "bg-down-soft text-down",
    warn: "bg-warn-soft text-warn",
    accent: "bg-accent-soft text-accent",
    muted: "bg-bg text-muted",
  }[tone];
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

export const usd = (n: number | null | undefined, d = 2) =>
  n === null || n === undefined ? "–" : `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
