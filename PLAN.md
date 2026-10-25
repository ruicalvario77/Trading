# Trading Platform Plan

A systematic swing trading platform: scan after the close, plan the trade, place a bracket order, manage the stop, exit by rule, journal everything. Paper trading first, for at least six months.

## Stack

| Layer | Choice | Why |
|---|---|---|
| App and API | Next.js (App Router, TypeScript) on Vercel | One deploy for UI, API routes and scheduled jobs |
| Database | Postgres (Neon, via Vercel Marketplace) with Drizzle ORM | Free tier, auto-injected `DATABASE_URL`, serverless friendly |
| Market data and broker | Alpaca (paper account, free IEX data feed) | Free, supports bracket orders, same API for paper and live |
| Scheduled jobs | Vercel Cron | Nightly scan and stop management after the close, order placement before the open |
| Auth | Single-user password in an env var, signed cookie | One user, no accounts to manage |

## Modules, in build order

1. **Data layer**: daily bars for a universe of liquid US stocks and ETFs, synced nightly from Alpaca into Postgres.
2. **Scanner**: pullback-in-uptrend setup over the universe, ranked candidates, run by cron after the close.
3. **Trade planner**: entry, stop, target, share count from account risk settings. Rejects anything that breaks the limits.
4. **Order manager**: submits bracket orders to Alpaca paper, cancels untriggered entries after 2 days, records fills.
5. **Position manager**: raises the stop to breakeven at +1R, trails below swing lows, enforces the 10-day time stop.
6. **Journal and stats**: every trade logged automatically, R multiples, win rate, expectancy, rule compliance.
7. **Backtester**: same setup logic replayed over history with commissions and slippage, walk-forward split.

## Account rules (defaults, editable in settings)

| Rule | Default |
|---|---|
| Risk per trade | 1% of account |
| Max open positions | 5 |
| Weekly loss limit | 4% of account, then no new entries until Monday |
| Universe | Price above $10, average volume above 1M shares |
| Target | 2R |
| Time stop | 10 trading days |

## Scheduled jobs

| Job | When (US Eastern) | Does |
|---|---|---|
| `after-close` | 17:00 Mon to Fri | Sync bars, run scanner, manage open positions, cancel stale entries |
| `pre-open` | 09:00 Mon to Fri | Submit bracket orders for approved candidates |

Two jobs keeps the project within the Vercel Hobby plan cron limits.

## Environment variables

| Name | Source |
|---|---|
| `DATABASE_URL` | Injected by the Neon integration |
| `APCA_API_KEY_ID` | Alpaca paper account dashboard |
| `APCA_API_SECRET_KEY` | Alpaca paper account dashboard |
| `APCA_API_BASE_URL` | `https://paper-api.alpaca.markets` |
| `APP_PASSWORD` | Chosen by the owner |
| `CRON_SECRET` | Random string, protects the cron routes |

## What the owner provides

1. Vercel: install the Vercel GitHub app on `ruicalvario77/trading`, or approve the project link when asked.
2. Alpaca: create a free account, open a paper trading account, generate an API key and secret, add them as env vars in the Vercel project.
3. Neon: in the Vercel project, Storage tab, create a Postgres database. It injects `DATABASE_URL`.
4. Decide: starting paper account size, home timezone, and country (affects whether a live Alpaca account is available later).

## Milestones

| Milestone | Deliverable |
|---|---|
| 1 | Repo scaffolded, deployed to Vercel, dashboard shell, nightly bar sync |
| 2 | Scanner live, candidates page shows tonight's setups |
| 3 | Trade planner and bracket orders to Alpaca paper, positions page |
| 4 | Stop management, exits, journal, stats page |
| 5 | Backtester with walk-forward validation |
| 6 | Six months of paper results compared to the backtest, then a decision about real capital |
