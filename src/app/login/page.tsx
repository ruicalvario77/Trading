import { setupStatus } from "@/lib/env";
import { Pill } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const status = setupStatus();
  const hasPassword = status.find((s) => s.key === "APP_PASSWORD")!.present;
  return (
    <div className="mx-auto max-w-md space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      {hasPassword ? (
        <form action="/api/login" method="post" className="space-y-3 rounded-lg border border-line bg-surface p-5">
          <label className="block text-sm">
            <span className="text-muted">Password</span>
            <input id="password" name="password" type="password" autoComplete="current-password" required
              className="mt-1 w-full rounded border border-line bg-bg px-3 py-2" />
          </label>
          {error && <p className="text-sm text-down">That password did not match.</p>}
          <button type="submit" className="rounded bg-accent px-4 py-2 text-sm font-medium text-white">Sign in</button>
        </form>
      ) : (
        <div className="rounded-lg border border-line bg-surface p-5 text-sm">
          <p>No dashboard password is set yet. Add an environment variable named <code className="num">APP_PASSWORD</code> in the Vercel project, redeploy, and sign in with it.</p>
        </div>
      )}
      <div className="rounded-lg border border-line bg-surface p-5">
        <h2 className="mb-3 text-sm font-semibold">Setup status</h2>
        <ul className="space-y-2 text-sm">
          {status.map((s) => (
            <li key={s.key} className="flex items-start justify-between gap-3">
              <div>
                <div>{s.label}</div>
                {!s.present && <div className="text-xs text-muted">{s.hint}</div>}
              </div>
              <Pill tone={s.present ? "up" : "warn"}>{s.present ? "set" : "missing"}</Pill>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
