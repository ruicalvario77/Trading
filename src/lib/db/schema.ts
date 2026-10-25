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
  plannedTarget: doublePrecision("planned_target").notNull(),
  shares: integer("shares").notNull(),
  riskUsd: doublePrecision("risk_usd").notNull(),
  currentStop: doublePrecision("current_stop").notNull(),
  breakevenMoved: boolean("breakeven_moved").notNull().default(false),
  brokerOrderId: text("broker_order_id"),
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
