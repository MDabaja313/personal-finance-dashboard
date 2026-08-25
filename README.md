# Personal Finance Dashboard

A private, single-user personal finance dashboard — accounts, transactions, budgets, bills,
goals, and analytics.

**Status:** mock-backed (Phase 5 complete). The Supabase database schema, RLS, migrations, and
authentication are provisioned and verified both locally and hosted — login, logout, and route
protection all work end to end — but every page still reads deterministic fixture data through a
data-access layer shaped like the eventual database queries; the Phase 6 DAL swap to real Supabase
queries is next. See [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) for the full roadmap.

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
| `npm run auth:reset-local` | Rebuild the local database around one real, login-capable owner (see [Local auth setup](#local-auth-setup)) |
| `npm run auth:verify` | Runtime-verify the auth flow against a running `npm run dev` (see [Local auth setup](#local-auth-setup)) |
| `npm run db:reset` | `supabase db reset` — schema + fixture seed, **not** login-capable on its own |
| `npm run db:test` | Run the pgTAP database test suite |

## Project structure

```
app/(app)/**      Routes protected by app/(app)/layout.tsx's requireUser() guard
app/(auth)/**     Public routes — /login only, no signup
components/**     UI. components/ui/** is shadcn-generated; don't hand-edit it
lib/auth/**       App-facing identity facade + signIn/signOut Server Actions
lib/data/**       The data-access layer — the only code that queries the database (fixtures today)
lib/finance/**    Pure financial calculations — no DB, no fixtures, no React, no clock access
lib/mock/**       Fixture data, read only by lib/data/**
lib/supabase/**   The only layer that reads Supabase env vars or constructs a Supabase client
lib/format/**     Display formatting — the only place floats appear
lib/types/**      Shared DTOs, including the branded Cents money type
docs/**           Database schema, RLS policy, and auth design
```

Key boundaries, enforced by `eslint.config.mjs`: `app/**` routes may call `lib/data/**`, but
`components/**` may not — it never imports `lib/data/**` or `lib/mock/**` directly, only the
props a route passes down. `lib/mock/**` is read only through `lib/data/**`, which is the sole
layer that queries fixtures today and the database later. `lib/finance/**` stays pure — no data
layer, no database, no React, no clock access. `lib/supabase/**` is reachable only from
`lib/auth/**` and the root `proxy.ts` — neither `app/**` nor `components/**` may import it
directly (`lib/auth/**` and the auth Server Actions are the sanctioned crossing point).

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

`.env.example` lists the required variable **names** only — every value is a placeholder. Copy it
to `.env.local` and fill in real values; `.env.local` is gitignored and must never be committed.

| Variable | Used by |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `lib/supabase/**` — the Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `lib/supabase/**` — the publishable (browser-safe) key |
| `LOCAL_OWNER_EMAIL` | `scripts/provision-owner.ts` / `scripts/verify-auth.ts` — local-only, never the hosted owner's real email |
| `LOCAL_OWNER_PASSWORD` | `scripts/provision-owner.ts` / `scripts/verify-auth.ts` — local-only |
| `OWNER_TIMEZONE` | `scripts/provision-owner.ts` — an IANA timezone name, e.g. `America/Toronto` |

No `service_role`/admin/database-secret variable belongs here or anywhere in application code —
see [docs/auth-design.md §11](docs/auth-design.md#11-no-service_role-in-application-code).

## Local auth setup

Public signup is disabled, both locally and hosted — there is one owner, provisioned by hand, ever
(`docs/auth-design.md §1`). Two local commands touch the database, and they do **different**
things:

- **`npm run db:reset`** — `supabase db reset`. Rebuilds the schema and applies the deterministic
  fixture seed (`supabase/seed.sql`). Its `auth.users` row is a placeholder Auth internals cannot
  actually use — GoTrue owns the password hash and identity records, and a row inserted straight
  by SQL is invisible to the Auth API. **This environment is not login-capable.**
- **`npm run auth:reset-local`** — resets the database (`supabase db reset --no-seed`), creates a
  real owner through the Supabase Auth Admin API at the same deterministic UUID the fixture seed
  targets, then applies the same seed on top. The result is login-capable **and** carries the same
  fixture financial data. Requires `LOCAL_OWNER_EMAIL`, `LOCAL_OWNER_PASSWORD`, and
  `OWNER_TIMEZONE` in `.env.local`.

**If you need to log in after an ordinary `npm run db:reset`, rerun `npm run auth:reset-local`** —
`db:reset` alone leaves the database without a usable owner.

`supabase/config.toml` has two different `enable_signup` settings — don't confuse them: the
project-level `[auth] enable_signup` stays `false` (no self-service signup, ever), while
`[auth.email] enable_signup` stays `true` — that one gates the email/password *provider* itself,
and setting it to `false` breaks `signInWithPassword()` for the owner with "Email logins are
disabled." See [docs/auth-design.md §1](docs/auth-design.md#1-provider-and-provisioning-model).

Once `auth:reset-local` has run, verify the flow actually works end to end against a running dev
server:

```bash
npm run dev            # in one terminal
npm run auth:verify    # in another
```

`auth:verify` drives real HTTP requests (login, protected routes, logout) against `localhost:3000`
and exits non-zero on any mismatch — see `scripts/verify-auth.ts` for exactly what it proves.
