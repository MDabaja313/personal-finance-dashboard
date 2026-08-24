# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

**Current phase:** Phase 5 (Authentication) complete — see `DEVELOPMENT_PLAN.md` for the authoritative phase roadmap. `lib/supabase/**` (browser/server/proxy Supabase clients), `lib/auth/**` (the app-facing identity facade and `signIn`/`signOut` Server Actions), `proxy.ts` (session-cookie refresh via `getClaims()`), `app/(auth)/login`, and the `requireUser()` guard in `app/(app)/layout.tsx` are implemented and verified both statically (`lib/auth/posture.test.ts`) and at runtime (`npm run auth:verify`, `scripts/verify-auth.ts`). No signup route exists, or ever will. Phase 6 (DAL swap) is next. Locally, `npm run auth:reset-local` rebuilds the database around one real, login-capable owner at the same deterministic UUID the fixture seed targets — plain `npm run db:reset` alone is not login-capable; rerun `auth:reset-local` after it if you need to sign in. The Supabase schema, RLS/grants, triggers, views, seed data, and the hardened snapshot-writer (Phase 4) are implemented and verified both locally and hosted (`supabase/migrations/**`, `supabase/tests/database/**`). `error.tsx`/`loading.tsx`/`not-found.tsx` boundaries exist, `lib/errors.ts` defines the typed DAL error taxonomy (no live throw sites yet), `TransactionFilters` supports `from`/`to`, and `lib/data/**` has explicit ordering contracts. Phase 2 (data architecture & security design) is complete — see `docs/database-schema.md`, `docs/rls-policies.md`, `docs/auth-design.md`. **The application itself still has no persistence, no mutating Server Actions** — `lib/data/**` remains mock-fixture-backed until the Phase 6 DAL swap.

## Commands

- `npm run dev` — start the dev server (http://localhost:3000)
- `npm run build` — production build
- `npm run start` — run the production build
- `npm run lint` — run ESLint
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — run Vitest once; `npm run test:watch` for watch mode. Scoped to `lib/**/*.test.ts` (`lib/finance/**` and fixture coherence, `lib/auth/**` unit + static posture tests) — no component tests.
- `npm run auth:reset-local` — rebuild the local database around one real, login-capable owner (`scripts/provision-owner.ts`). Plain `npm run db:reset` alone is not login-capable.
- `npm run auth:verify` — runtime-verify the auth flow against a running `npm run dev` (`scripts/verify-auth.ts`).

## Stack notes

- **App Router**, `@/*` aliased to the repo root.
- **Tailwind CSS v4, CSS-first** — no `tailwind.config.*`; tokens live in `app/globals.css` via `@theme inline`. Dark mode is the `.dark` class, driven by `next-themes` (`components/theme-provider.tsx`).
- **shadcn/ui** — primitives in `components/ui/**` are generated (`npx shadcn@latest add ...`); don't hand-edit them.
- Next.js 16: `middleware.ts` is renamed `proxy.ts`; `cookies()` is async. See `AGENTS.md`.

## Architecture invariants

- **Money is integer cents**, branded `Cents` (`lib/types`). Never floats, never `parseFloat`. Convert to decimal only in `lib/format/currency.ts`. A `bigint` crossing the DB→TS boundary must pass a `Number.isSafeInteger` check — never silently coerced.
- **Percentages are display-only, divide-first**: `percentage(num, den)` in `lib/finance/money.ts` computes `(num/den)*10000` rounded, never `(num*10000)/den` — the latter can silently exceed the safe-integer range before dividing. Returns `null` for a zero denominator or non-finite result; render as `—`, never `NaN`/`Infinity`. A meter's *text* percentage may exceed 100 (over-budget, over-funded goal) — only its CSS width is clamped to [0, 100].
- **Dates are `'YYYY-MM-DD'` strings.** Never `new Date('YYYY-MM-DD')` on a financial date. Parse via `lib/finance/dates.ts` (`parseCalendarDate`, re-exported from `lib/format/date.ts`); day-count math (`daysBetween`) uses `Date.UTC`, not local-midnight subtraction, so it's DST-safe.
- **Transaction meaning is `kind` + sign together, never sign alone.** `income` +, `expense` −, `refund` +, `transfer`/`credit_card_payment` source − / destination +. The latter two are paired legs sharing one `movementId` (exactly two, summing to zero), excluded from income/spending/cash-flow but still visible in each account's own history. See `lib/types/index.ts` and `lib/finance/transactions.ts`.
- **Account balances are signed** (assets +, liabilities −). Display splits it: `totalAssets`/`totalLiabilities` (positive magnitude) and `netWorth` (signed sum), such that `netWorth === totalAssets - totalLiabilities`. `NetWorthSnapshot` commits to the same convention explicitly (`netWorthCents` stored, not implied) — never compare it against raw signed balances.
- **`today` is always an explicit parameter**, supplied by `lib/data/clock.ts` (`getToday()`, fixed at `MOCK_TODAY` during the mock phase). `lib/finance/**` never reads the clock — ESLint blocks `Date.now()`/`new Date()` there.
- **Every list-returning `lib/data/**` function has an explicit `ORDER BY`-equivalent sort** — see `docs/database-schema.md §17` for the full contract per function. Never rely on fixture array order. When a DAL function only guarantees a *technical* order (e.g. `getBudgets()`'s `category_id ASC`, since it has no join to `categories`), the calling page applies its own semantic display order using data it already fetched — a UUID must never become a visible sort order. `getTransactions()` orders `date DESC, created_at DESC, id ASC`; `created_at` never appears on the `Transaction` DTO.
- **Layer boundaries** (enforced by `eslint.config.mjs` where the layer exists):
  - `lib/data/**` — the only layer that queries the database (or reads mock fixtures now). `'server-only'`, returns DTOs.
  - `lib/mock/**` — fixtures. Only `lib/data/**` may import them; `app/**` and `components/**` are blocked.
  - `lib/supabase/**` — the only layer that reads Supabase env vars / constructs clients. Reachable only from `lib/auth/**` and the root `proxy.ts`; `app/**` and `components/**` are blocked from importing it directly.
  - `lib/auth/**` — the app-facing identity seam: `getVerifiedClaims()`/`requireUser()` (`lib/auth/session.ts`) and the `signIn`/`signOut` Server Actions (`lib/auth/actions.ts`). `app/**` and `components/**` call into this, never into `lib/supabase/**` directly. No `signUp` — public signup is disabled, permanently.
  - `lib/finance/**` — pure calculations: no `lib/data`, `lib/mock`, `lib/supabase`, React, or clock access.
  - `components/**` — UI + local state/interactivity only. No DB/DAL/fixture access, no `process.env`, no derived financial arithmetic (call the tested `lib/finance` function instead), no `lib/supabase/**` or `lib/auth/**` value imports (the action/session helpers arrive as props; a type-only `lib/auth/types` import is fine, since it carries no runtime access).
- **Auth:** use verified claims/user identity (`getClaims()` for page/proxy protection, `getUser()` when an up-to-date Auth record is specifically needed) for server-side authorization — never `getSession()`, since cookie-backed session data isn't itself verified. See `docs/auth-design.md`. RLS is enabled on every table even though this is single-user — the publishable key is public. `service_role` never runs in application code. This posture (no `getSession()` authorization, no `signUp()`, the import boundaries above) is a static regression test, not just documented convention — see `lib/auth/posture.test.ts`.
- **Server Actions are independently reachable endpoints** — re-verify auth and row ownership inside the DAL, not just at the page level.
