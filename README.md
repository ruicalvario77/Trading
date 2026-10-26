# Trading

A systematic swing trading platform for one person. It scans after the US close, plans each trade from written risk rules, places bracket orders at a paper broker, manages stops, exits by rule, and journals every trade. See `PLAN.md` for the full plan and milestones.

## Stack

Next.js 15 on Vercel, Postgres (Neon) with Drizzle, Alpaca for market data and paper trading, Vercel Cron for the two daily jobs.

## Setup on Vercel

1. Import this repository as a Vercel project.
2. Storage tab, create a Neon Postgres database. It injects `DATABASE_URL`.
3. Create a free Alpaca account, open the paper account, generate API keys.
4. Project settings, Environment Variables, add the variables listed in `.env.example`. `CRON_SECRET` is any long random string. `APP_PASSWORD` is the dashboard password.
5. Redeploy. Sign in, open Overview, press "Run after-close job now". The first run creates the tables, pulls about 460 days of daily bars for the universe, and runs the scanner.

Tables are created automatically by the job, so no database CLI access is needed.

## Local development

```bash
cp .env.example .env.local   # fill in values
npm install
npm run dev
npm test                     # planner and strategy tests
npm run typecheck
```

## Jobs

| Route | Schedule (UTC) | SAST | Does |
|---|---|---|---|
| `/api/cron/after-close` | 22:00 Mon to Fri | 00:00 | Sync order fills, sync bars, run scanner, store candidates |
| `/api/cron/pre-open` | 13:00 Mon to Fri | 15:00 | Sync order fills, place bracket orders for approved candidates |

Both accept a bearer `CRON_SECRET` from Vercel Cron or a signed-in session, so they can be run by hand from the Overview page.

## Layout

```
src/lib/strategy/pullback.ts   setup detection, pure function
src/lib/planner.ts             entry, stop, target, share count, pure function
src/lib/jobs/afterClose.ts     nightly sync + scan
src/lib/jobs/orders.ts         bracket order placement and fill sync
src/lib/trades.ts              order reconciliation and account limits, pure functions
src/lib/alpaca.ts              broker and data client
src/lib/db/schema.ts           Drizzle schema
src/lib/db/migrate.ts          idempotent CREATE TABLE statements
src/app/                       dashboard pages and API routes
```
