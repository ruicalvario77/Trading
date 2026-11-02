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
| 8 | Learning loop: 57 rule sets (hold, trend timing, ETF rotation, dual momentum, dip buying) re-tested monthly on the last three years; the index is the default champion and a challenger must beat it by more than luck could explain (1.34 risk-adjusted for 57 rule sets over 3 years); the champion is paper traded automatically; month-by-month self-test against SPY; live-readiness checklist | Paper trading since 26 Oct 2026. Champion: hold SPY. Self-test matches the index, +13.4%/yr since 2020 |
| 8a | Live gate: 6 months of paper, paper at least as good as SPY risk-adjusted, worst fall under 20%, fills within 0.3% of model, self-test beats the index, owner decision with a broker serving South Africa | Tracked on the Loop page |
| 9 | Phase 1, whole-market swing: universe of every US stock and ETF over $5 and $20M a day (rebuilt weekly, 4 years of history on the free database); 8 long-only setups (pullback, breakout, leader pullback, oversold bounce, gap that holds, quiet day, near 52-week high, failed breakdown); market-wide backtest with a Bonferroni luck bar; nightly forward record of every signal; setups that pass both are paper traded automatically with their own exits | First backtest 26 Oct 2026 (2023-10 to 2026-10, 2,722 symbols, luck bar 2.50): only "near a 52-week high" passed, +0.10R over 17,983 trades, evidence 4.17, positive in both halves. Now on its forward record; forward results count only once a signal's full 30-day holding period has passed, so the first complete trades arrive around 16 Dec 2026. Breakout (+0.07R, 1.66) and gap (+0.07R, 1.06) fell short of the bar; the rest averaged near or below zero |
| 9a | Phase 2, day trading groundwork: five-minute full-market bars for the 60 most traded stocks and ETFs (fetched on demand, not stored); 3 intraday setups (opening range breakout on stocks in play, gap and go, stretch below VWAP), long only, flat by the close, 0.05% cost per side; same pass rules and luck bar; every weekday morning the previous session is replayed and its trades stored as a forward record | First backtest 2 Nov 2026 (2026-05-04 to 2026-10-30, 60 symbols, 7,486 sessions, luck bar 2.13): all three failed. Opening range breakout -0.13R over 67 trades; gap and go +0.05R over 216 but evidence -0.61 and negative second half; stretch below VWAP -0.16R over 1,397. Forward record keeps running each morning |
| 9a-1 | Two research-backed intraday setups added 2 Nov 2026: last half hour momentum on SPY, QQQ, IWM and DIA (Gao, Han, Li and Zhou 2018), and a five-minute breakout on the daily top 20 stocks in play from the 500 most traded (Zarattini, Barbon and Aziz 2024), long only, with stated deviations. Luck bar now covers 5 intraday setups (2.33). Both join the morning forward record | Built, owner to run both backtests |
| 9a-2 | Day trading paper execution: always-on worker during US hours (about $5 a month), real-time data | Only after an intraday setup passes the backtest and 30 forward trades |
| 9b | Daily email briefing after each scan | Needs an email provider key from the owner |
| 10 | At least 30 paper trades compared with the test, then a decision about real capital | Later |
