import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trading",
  description: "Systematic swing trading: scan, plan, bracket, manage, exit, journal.",
};

const nav = [
  { href: "/", label: "Overview" },
  { href: "/candidates", label: "Candidates" },
  { href: "/positions", label: "Positions" },
  { href: "/journal", label: "Journal" },
  { href: "/settings", label: "Settings" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="font-semibold tracking-tight">Trading</Link>
            <nav className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
              {nav.map((n) => (
                <Link key={n.href} href={n.href} className="hover:text-ink">{n.label}</Link>
              ))}
            </nav>
            <form action="/api/logout" method="post" className="ml-auto">
              <button className="text-sm text-muted hover:text-ink" type="submit">Log out</button>
            </form>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
