# Personal Finance Dashboard

A private, single-user personal finance dashboard — accounts, transactions, budgets, bills,
goals, and analytics.

**Status:** mock-backed (Phase 3 complete). No database, authentication, or persistence yet
— every page reads deterministic fixture data through a data-access layer shaped like the
eventual database queries. See [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) for the full roadmap.

## Stack

- **Next.js 16** (App Router, Turbopack) · **React 19** · **TypeScript**, strict mode
- **Tailwind CSS v4**, CSS-first (no `tailwind.config.*`; tokens in `app/globals.css`)
- **shadcn/ui** primitives + **Recharts** for charts
- **Vitest** for the calculation and data-access layers

## Setup

```bash
git clone <your-repo-url>
cd personal-finance-dashboard
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). `npm ci` installs exactly what
`package-lock.json` specifies — the right command for a clean clone. Use `npm install` instead
only when you're intentionally changing dependency resolution.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run start` | Run the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |

## Project structure

```
app/(app)/**      Routes — Server Components, one route group with a shared sidebar/header shell
components/**     UI. components/ui/** is shadcn-generated; don't hand-edit it
lib/data/**       The data-access layer — the only code that queries the database (fixtures today)
lib/finance/**    Pure financial calculations — no DB, no fixtures, no React, no clock access
lib/mock/**       Fixture data, read only by lib/data/**
lib/format/**     Display formatting — the only place floats appear
lib/types/**      Shared DTOs, including the branded Cents money type
docs/**           Database schema, RLS policy, and auth design (ahead of implementation)
```

Key boundaries, enforced by `eslint.config.mjs`: `app/**` routes may call `lib/data/**`, but
`components/**` may not — it never imports `lib/data/**` or `lib/mock/**` directly, only the
props a route passes down. `lib/mock/**` is read only through `lib/data/**`, which is the sole
layer that queries fixtures today and the database later. `lib/finance/**` stays pure — no data
layer, no database, no React, no clock access.

## Financial invariants (high level)

- **Money is integer cents**, a branded `Cents` type — never floats, never `parseFloat`.
- **Dates are `'YYYY-MM-DD'` strings** (`CalendarDate`), never ambiguous `Date` objects.
- **Transaction meaning is `kind` plus sign together**, never sign alone.
- **Account balances are signed**; assets and liabilities are split out for display.
- **`today` is always an explicit parameter**, never read from the system clock inside a
  calculation.

The full architecture — schema, invariants, and the reasoning behind each — lives in
[docs/database-schema.md](docs/database-schema.md),
[docs/rls-policies.md](docs/rls-policies.md), and
[docs/auth-design.md](docs/auth-design.md). This README is an orientation, not the source of
truth — see those files for anything beyond a first read.

## Environment

`.env.example` lists the environment variables the app will eventually need — all placeholders,
none of them wired up yet. Copy it to `.env.local` only once Supabase is actually configured
(Phase 5). **Never commit real credentials.**
