# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

**Current phase:** Phase 4 (Supabase provisioning & migrations) complete — see `DEVELOPMENT_PLAN.md` for the authoritative phase roadmap. The Supabase schema, RLS/grants, triggers, views, seed data, and the hardened snapshot-writer are implemented and verified both locally and hosted (`supabase/migrations/**`, `supabase/tests/database/**`). Phase 5 (Authentication) is next. `error.tsx`/`loading.tsx`/`not-found.tsx` boundaries exist, `lib/errors.ts` defines the typed DAL error taxonomy (no live throw sites yet), `TransactionFilters` supports `from`/`to`, and `lib/data/**` has explicit ordering contracts. Phase 2 (data architecture & security design) is complete — see `docs/database-schema.md`, `docs/rls-policies.md`, `docs/auth-design.md`. **The application itself still has no Supabase client, no auth, no persistence, no Server Actions** — `lib/data/**` remains mock-fixture-backed until the Phase 6 DAL swap.

## Commands

- `npm run dev` — start the dev server (http://localhost:3000)
- `npm run build` — production build
- `npm run start` — run the production build
- `npm run lint` — run ESLint
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — run Vitest once; `npm run test:watch` for watch mode. Scoped to `lib/**/*.test.ts` (`lib/finance/**` and fixture coherence) — no component tests.

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
  - `lib/supabase/**` — the only layer that reads Supabase env vars / constructs clients (doesn't exist yet).
  - `lib/finance/**` — pure calculations: no `lib/data`, `lib/mock`, `lib/supabase`, React, or clock access.
  - `components/**` — UI + local state/interactivity only. No DB/DAL/fixture access, no `process.env`, no derived financial arithmetic (call the tested `lib/finance` function instead).
- **Auth:** use verified claims/user identity (`getClaims()` for page/proxy protection, `getUser()` when an up-to-date Auth record is specifically needed) for server-side authorization — never `getSession()`, since cookie-backed session data isn't itself verified. See `docs/auth-design.md`. RLS is enabled on every table even though this is single-user — the publishable key is public. `service_role` never runs in application code.
- **Server Actions are independently reachable endpoints** — re-verify auth and row ownership inside the DAL, not just at the page level.
