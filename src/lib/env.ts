export type EnvKey =
  | "DATABASE_URL"
  | "APCA_API_KEY_ID"
  | "APCA_API_SECRET_KEY"
  | "APCA_API_BASE_URL"
  | "APP_PASSWORD"
  | "CRON_SECRET";

export function env(key: EnvKey): string | undefined {
  const v = process.env[key];
  return v && v.length > 0 ? v : undefined;
}

export function alpacaBaseUrl(): string {
  return env("APCA_API_BASE_URL") ?? "https://paper-api.alpaca.markets";
}

export function isPaper(): boolean {
  return alpacaBaseUrl().includes("paper");
}

export type SetupItem = { key: EnvKey; label: string; present: boolean; hint: string };

export function setupStatus(): SetupItem[] {
  return [
    { key: "DATABASE_URL", label: "Postgres database", present: !!env("DATABASE_URL"), hint: "Vercel project, Storage tab, create a Neon Postgres database." },
    { key: "APCA_API_KEY_ID", label: "Alpaca API key", present: !!env("APCA_API_KEY_ID"), hint: "Alpaca dashboard, paper account, generate API key." },
    { key: "APCA_API_SECRET_KEY", label: "Alpaca API secret", present: !!env("APCA_API_SECRET_KEY"), hint: "Shown once when the key is generated." },
    { key: "APP_PASSWORD", label: "Dashboard password", present: !!env("APP_PASSWORD"), hint: "Any password you choose. Set it in Vercel project environment variables." },
    { key: "CRON_SECRET", label: "Cron secret", present: !!env("CRON_SECRET"), hint: "Random string so only Vercel Cron can trigger the jobs." },
  ];
}
