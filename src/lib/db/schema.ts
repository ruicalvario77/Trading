import {
  pgTable, text, integer, doublePrecision, boolean, timestamp, date, bigint, jsonb, serial, primaryKey, index,
} from "drizzle-orm/pg-core";

// One row, id = 1. Account-level rules the platform enforces.
export const settings = pgTable("settings", {
  id: integer("id").primaryKey(),
  accountUsd: doublePrecision("account_usd").notNull(),
  zarPerUsd: doublePrecision("zar_per_usd").notNull(),
  riskPct: doublePrecision("risk_pct").notNull(),
  maxPositions: integer("max_positions").notNull(),
  weeklyLossLimitPct: doublePrecision("weekly_loss_limit_pct").notNull(),
  maxPositionPct: doublePrecision("max_position_pct").notNull(),
  minPrice: doublePrecision("min_price").notNull(),
  maxPrice: doublePrecision("max_price").notNull(),
  minAvgVolume: integer("min_avg_volume").notNull(),
  targetR: doublePrecision("target_r").notNull(),
  timeStopDays: integer("time_stop_days").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const symbols = pgTable("symbols", {
  symbol: text("symbol").primaryKey(),
  name: text("name"),
  kind: text("kind").notNull().default("stock"), // stock | etf
  active: boolean("active").notNull().default(true),
  avgDollarVolume: doublePrecision("avg_dollar_volume"),
  lastClose: doublePrecision("last_close"),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
});

export const bars = pgTable(
  "bars",
  {
    symbol: text("symbol").notNull(),
    date: date("date").notNull(),
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    volume: bigint("volume", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.date] }), index("bars_date_idx").on(t.date)],
);

export const scans = pgTable("scans", {
  id: serial("id").primaryKey(),
  tradeDate: date("trade_date").notNull(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  universeSize: integer("universe_size").notNull(),
  withEnoughHistory: integer("with_enough_history").notNull(),
  passedFilters: integer("passed_filters").notNull(),
  candidateCount: integer("candidate_count").notNull(),
});

export const candidates = pgTable(
  "candidates",
  {
    id: serial("id").primaryKey(),
    scanId: integer("scan_id").notNull(),
    tradeDate: date("trade_date").notNull(),
    symbol: text("symbol").notNull(),
    close: doublePrecision("close").notNull(),
    score: doublePrecision("score").notNull(),
    entry: doublePrecision("entry"),
    stop: doublePrecision("stop"),
    target: doublePrecision("target"),
    shares: integer("shares"),
    riskUsd: doublePrecision("risk_usd"),
    positionUsd: doublePrecision("position_usd"),
    tradeable: boolean("tradeable").notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull(),
    why: text("why"),
    setup: text("setup"),
    plan: jsonb("plan").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("new"), // new | approved | rejected | ordered | expired
  },
  (t) => [index("candidates_trade_date_idx").on(t.tradeDate)],
);

export const trades = pgTable("trades", {
  id: serial("id").primaryKey(),
  candidateId: integer("candidate_id"),
  symbol: text("symbol").notNull(),
  setup: text("setup").notNull().default("pullback"),
  status: text("status").notNull(), // pending_entry | open | closed | cancelled
  plannedEntry: doublePrecision("planned_entry").notNull(),
  plannedStop: doublePrecision("planned_stop").notNull(),
  plannedTarget: doublePrecision("planned_target"), // null when the setup has no target
  shares: integer("shares").notNull(),
  riskUsd: doublePrecision("risk_usd").notNull(),
  currentStop: doublePrecision("current_stop").notNull(),
  breakevenMoved: boolean("breakeven_moved").notNull().default(false),
  brokerOrderId: text("broker_order_id"),
  exitOrderId: text("exit_order_id"),
  plan: jsonb("plan").$type<Record<string, unknown>>(),
  entryFill: doublePrecision("entry_fill"),
  enteredAt: timestamp("entered_at", { withTimezone: true }),
  exitFill: doublePrecision("exit_fill"),
  exitedAt: timestamp("exited_at", { withTimezone: true }),
  exitReason: text("exit_reason"), // stop | target | trail | time | manual
  pnlUsd: doublePrecision("pnl_usd"),
  rMultiple: doublePrecision("r_multiple"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const journal = pgTable("journal", {
  id: serial("id").primaryKey(),
  tradeId: integer("trade_id"),
  rulesFollowed: boolean("rules_followed").notNull(),
  brokenRule: text("broken_rule"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const backtestRuns = pgTable("backtest_runs", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  params: jsonb("params").$type<Record<string, unknown>>().notNull(),
  results: jsonb("results").$type<unknown>().notNull(),
});

export const backfills = pgTable("backfills", {
  symbol: text("symbol").primaryKey(),
  earliest: date("earliest"),
  doneAt: timestamp("done_at", { withTimezone: true }).notNull().defaultNow(),
});

export const labRuns = pgTable("lab_runs", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  results: jsonb("results").$type<unknown>().notNull(),
});

/** One row per strategy version whose sealed 2023+ result has been opened. Never deleted. */
export const labReveals = pgTable(
  "lab_reveals",
  {
    strategy: text("strategy").notNull(),
    version: text("version").notNull(),
    runId: integer("run_id").notNull(),
    revealedAt: timestamp("revealed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.strategy, t.version] })],
);

// Learning loop
export const loopState = pgTable("loop_state", {
  id: integer("id").primaryKey(),
  status: text("status").notNull(), // off | paper
  startedAt: date("started_at"),
  startEquity: doublePrecision("start_equity"),
  cash: doublePrecision("cash").notNull(),
  spyStart: doublePrecision("spy_start"),
  champion: text("champion"),
  championReason: text("champion_reason"),
  appliedTarget: jsonb("applied_target").$type<Record<string, number> | null>(),
  lastResearchAt: timestamp("last_research_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const loopHoldings = pgTable("loop_holdings", {
  symbol: text("symbol").primaryKey(),
  shares: integer("shares").notNull(),
});

export const loopOrders = pgTable("loop_orders", {
  id: serial("id").primaryKey(),
  brokerId: text("broker_id").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  qty: integer("qty").notNull(),
  expectedPrice: doublePrecision("expected_price").notNull(),
  status: text("status").notNull(), // open | filled | dead
  fillPrice: doublePrecision("fill_price"),
  filledQty: integer("filled_qty"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  filledAt: timestamp("filled_at", { withTimezone: true }),
});

export const loopEquity = pgTable("loop_equity", {
  date: date("date").primaryKey(),
  equity: doublePrecision("equity").notNull(),
  spyClose: doublePrecision("spy_close").notNull(),
  champion: text("champion"),
});

export const loopResearch = pgTable("loop_research", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  results: jsonb("results").$type<unknown>().notNull(),
});

// Whole-market setups
export const setupRuns = pgTable("setup_runs", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  results: jsonb("results").$type<unknown>().notNull(),
});

/** Every signal every setup gives, followed forward with the same rules as the backtest. No orders. */
export const shadowSignals = pgTable(
  "shadow_signals",
  {
    id: serial("id").primaryKey(),
    setup: text("setup").notNull(),
    version: text("version").notNull(),
    symbol: text("symbol").notNull(),
    signalDate: date("signal_date").notNull(),
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
    score: doublePrecision("score").notNull(),
    why: text("why"),
    status: text("status").notNull(), // pending | open | closed | unfilled
    entryDate: date("entry_date"),
    exitDate: date("exit_date"),
    entry: doublePrecision("entry"),
    exit: doublePrecision("exit"),
    r: doublePrecision("r"),
    reason: text("reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shadow_status_idx").on(t.status), index("shadow_date_idx").on(t.signalDate)],
);

export const jobRuns = pgTable("job_runs", {
  id: serial("id").primaryKey(),
  job: text("job").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  ok: boolean("ok"),
  summary: jsonb("summary").$type<Record<string, unknown>>(),
  error: text("error"),
});

export type Settings = typeof settings.$inferSelect;
export type Bar = typeof bars.$inferSelect;
export type Candidate = typeof candidates.$inferSelect;
export type Trade = typeof trades.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;
