# Trading Platform Plan

A systematic swing trading platform: scan after the close, plan the trade, place a bracket order, manage the stop, exit by rule, journal everything. Paper trading first, for at least six months.

## Stack

| Layer | Choice | Why |
|---|---|---|
| App and API | Next.js (App Router, TypeScript) on Vercel | One deploy for UI, API routes and scheduled jobs |
| Database | Postgres (Neon, via Vercel Marketplace) with Drizzle ORM | Free tier, auto-injected `DATABASE_URL`, serverless friendly |
| Market data and broker | Alpaca (paper account, free full-market daily history back to 2016) | Free, supports bracket orders, same API for paper and live |
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
| Account | R100,000 (about $5,556), paper |
| Risk per trade | 1% of account |
| Max open positions | 5 |
| Weekly loss limit | 4% of account, then no new entries until Monday |
| Universe | Price $5 to $500, 20-day average volume above 1M shares |
| Max position size | 20% of account |
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

| Milestone | Deliverable | Status |
|---|---|---|
| 1 | Repo scaffolded, deployed to Vercel, dashboard shell, nightly bar sync | Done |
| 2 | Scanner live, candidates page shows tonight's setups | Done |
| 3 | Approve candidates, bracket orders to Alpaca paper, positions page | Done |
| 4 | Backtester: same scanner and planner over history since 2016, three trade-management styles compared, results at R100,000 and R10,000 | Done |
| 5 | Time stop live, journal with rule-compliance log, live stats compared with the backtest, plain-language reason on every candidate | Done |
| 6 | Backtest verdict: the pullback setup has no edge (about -0.06R per trade, 2017-2026, all three management styles). Approvals paused. | Done |
| 7 | Strategy lab, seals opened 26 Oct 2026. Sealed 2023-2026 vs SPY (+19.9%/yr, worst fall -19%): rotation +24.4%/yr but -30.6% fall; dip buying +1.0%/yr, -5.1%; filtered pullback -16.0%/yr, -49.8%. None met the pass mark. | Done |
| 8 | Learning loop: 57 rule sets (hold, trend timing, ETF rotation, dual momentum, dip buying) re-tested monthly on the last three years; the index is the default champion and a challenger must beat it by +0.10 risk-adjusted; the champion is paper traded automatically; month-by-month self-test against SPY; live-readiness checklist | Built, owner to start paper trading |
| 8a | Live gate: 6 months of paper, paper at least as good as SPY risk-adjusted, worst fall under 20%, fills within 0.3% of model, self-test beats the index, owner decision with a broker serving South Africa | Tracked on the Loop page |
| 9 | Daily email briefing after each scan | Needs an email provider key from the owner |
| 10 | At least 30 paper trades compared with the test, then a decision about real capital | Later |
