import { neon } from "@neondatabase/serverless";
import { env } from "../env";

// Idempotent schema creation, run by the jobs and the setup page so no CLI access to the database is needed.
const statements = [
  `CREATE TABLE IF NOT EXISTS settings (
    id integer PRIMARY KEY,
    account_usd double precision NOT NULL,
    zar_per_usd double precision NOT NULL,
    risk_pct double precision NOT NULL,
    max_positions integer NOT NULL,
    weekly_loss_limit_pct double precision NOT NULL,
    max_position_pct double precision NOT NULL,
    min_price double precision NOT NULL,
    max_price double precision NOT NULL,
    min_avg_volume integer NOT NULL,
    target_r double precision NOT NULL,
    time_stop_days integer NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS symbols (
    symbol text PRIMARY KEY,
    name text,
    kind text NOT NULL DEFAULT 'stock',
    active boolean NOT NULL DEFAULT true
  )`,
  `CREATE TABLE IF NOT EXISTS bars (
    symbol text NOT NULL,
    date date NOT NULL,
    open double precision NOT NULL,
    high double precision NOT NULL,
    low double precision NOT NULL,
    close double precision NOT NULL,
    volume bigint NOT NULL,
    PRIMARY KEY (symbol, date)
  )`,
  `CREATE INDEX IF NOT EXISTS bars_date_idx ON bars (date)`,
  `CREATE TABLE IF NOT EXISTS scans (
    id serial PRIMARY KEY,
    trade_date date NOT NULL,
    ran_at timestamptz NOT NULL DEFAULT now(),
    universe_size integer NOT NULL,
    with_enough_history integer NOT NULL,
    passed_filters integer NOT NULL,
    candidate_count integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS candidates (
    id serial PRIMARY KEY,
    scan_id integer NOT NULL,
    trade_date date NOT NULL,
    symbol text NOT NULL,
    close double precision NOT NULL,
    score double precision NOT NULL,
    entry double precision,
    stop double precision,
    target double precision,
    shares integer,
    risk_usd double precision,
    position_usd double precision,
    tradeable boolean NOT NULL,
    reasons jsonb NOT NULL,
    status text NOT NULL DEFAULT 'new'
  )`,
  `CREATE INDEX IF NOT EXISTS candidates_trade_date_idx ON candidates (trade_date)`,
  `CREATE TABLE IF NOT EXISTS trades (
    id serial PRIMARY KEY,
    candidate_id integer,
    symbol text NOT NULL,
    setup text NOT NULL DEFAULT 'pullback',
    status text NOT NULL,
    planned_entry double precision NOT NULL,
    planned_stop double precision NOT NULL,
    planned_target double precision NOT NULL,
    shares integer NOT NULL,
    risk_usd double precision NOT NULL,
    current_stop double precision NOT NULL,
    breakeven_moved boolean NOT NULL DEFAULT false,
    broker_order_id text,
    entry_fill double precision,
    entered_at timestamptz,
    exit_fill double precision,
    exited_at timestamptz,
    exit_reason text,
    pnl_usd double precision,
    r_multiple double precision,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS journal (
    id serial PRIMARY KEY,
    trade_id integer,
    rules_followed boolean NOT NULL,
    broken_rule text,
    note text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS app_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`,
  // One-time: the first default volume threshold (1,000,000) assumed consolidated volume, but the free
  // IEX feed reports about 2-3% of that. Move an untouched default to the IEX-calibrated value once.
  `WITH m AS (
    INSERT INTO app_migrations (name) VALUES ('iex_volume_threshold') ON CONFLICT DO NOTHING RETURNING name
  )
  UPDATE settings SET min_avg_volume = 25000, updated_at = now()
  WHERE min_avg_volume = 1000000 AND EXISTS (SELECT 1 FROM m)`,
  // One-time: the owner moved the paper account from R10,000 to R100,000. Five positions at 20% each and
  // a $500 price ceiling suit that size.
  `WITH m AS (
    INSERT INTO app_migrations (name) VALUES ('account_r100k') ON CONFLICT DO NOTHING RETURNING name
  )
  UPDATE settings SET account_usd = 5556, max_position_pct = 20, max_price = 500, updated_at = now()
  WHERE id = 1 AND EXISTS (SELECT 1 FROM m)`,
  `ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_order_id text`,
  `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS why text`,
  `CREATE TABLE IF NOT EXISTS backtest_runs (
    id serial PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    params jsonb NOT NULL,
    results jsonb NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS backfills (
    symbol text PRIMARY KEY,
    earliest date,
    done_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS lab_runs (
    id serial PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    results jsonb NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS lab_reveals (
    strategy text NOT NULL,
    version text NOT NULL,
    run_id integer NOT NULL,
    revealed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (strategy, version)
  )`,
  // One-time: switch from IEX-only prices (history from mid-2020, about 2% of volume) to full-market data
  // back to 2016. Old bars are cleared so the two feeds never mix; Load history refills them, and the
  // volume rule goes back to real shares.
  `WITH m AS (
    INSERT INTO app_migrations (name) VALUES ('sip_feed') ON CONFLICT DO NOTHING RETURNING name
  ), b AS (
    DELETE FROM bars WHERE EXISTS (SELECT 1 FROM m) RETURNING 1
  ), f AS (
    DELETE FROM backfills WHERE EXISTS (SELECT 1 FROM m) RETURNING 1
  )
  UPDATE settings SET min_avg_volume = 1000000, updated_at = now()
  WHERE min_avg_volume = 25000 AND EXISTS (SELECT 1 FROM m)`,
  `CREATE TABLE IF NOT EXISTS loop_state (
    id integer PRIMARY KEY,
    status text NOT NULL,
    started_at date,
    start_equity double precision,
    cash double precision NOT NULL,
    spy_start double precision,
    champion text,
    champion_reason text,
    applied_target jsonb,
    last_research_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `INSERT INTO loop_state (id, status, cash) VALUES (1, 'off', 0) ON CONFLICT DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS loop_holdings (symbol text PRIMARY KEY, shares integer NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS loop_orders (
    id serial PRIMARY KEY,
    broker_id text NOT NULL,
    symbol text NOT NULL,
    side text NOT NULL,
    qty integer NOT NULL,
    expected_price double precision NOT NULL,
    status text NOT NULL,
    fill_price double precision,
    filled_qty integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    filled_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS loop_equity (
    date date PRIMARY KEY,
    equity double precision NOT NULL,
    spy_close double precision NOT NULL,
    champion text
  )`,
  `CREATE TABLE IF NOT EXISTS loop_research (
    id serial PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    results jsonb NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS job_runs (
    id serial PRIMARY KEY,
    job text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    ok boolean,
    summary jsonb,
    error text
  )`,
];

let pending: Promise<void> | null = null;

/** Creates all tables once per server instance. Concurrent callers share the same run. */
export function ensureSchema(): Promise<void> {
  if (!pending) {
    pending = (async () => {
      const url = env("DATABASE_URL");
      if (!url) throw new Error("DATABASE_URL is not set");
      const sql = neon(url);
      for (const s of statements) await sql.query(s);
    })().catch((e) => {
      pending = null;
      throw e;
    });
  }
  return pending;
}
