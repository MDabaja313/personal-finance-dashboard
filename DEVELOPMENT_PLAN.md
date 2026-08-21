# Development Plan

This file is the single source of truth for project phases. Where any code comment names a
phase, this file is authoritative if the two ever disagree.

The original roadmap treated "read-only UI" and "financial calculations" as separate phases.
The actual implementation absorbed both into one delivery — the numbering below reflects what
was actually built, not the original plan.

## Phase 0 — Foundation ✅ complete

Next.js App Router scaffold, Tailwind v4 (CSS-first, no config file), shadcn/ui primitives,
`next-themes` wiring, project conventions (`@/*` alias, ESLint layer boundaries).

## Phase 1 — Read-only application ✅ complete

Absorbed the originally-separate "financial calculations" phase. Delivered together, in one
commit:

- All 8 routes (`dashboard`, `accounts`, `transactions`, `budgets`, `bills`, `goals`,
  `analytics`, `settings`), mock-fixture-backed via `lib/data/**`.
- `lib/finance/**` — 8 pure calculation modules, each with a colocated Vitest suite (66 tests
  total across 9 files, including fixture-coherence tests in `lib/mock/index.test.ts`).
- Analytics charts (6 charts + accessible data-table fallback) and the theme system
  (light/dark/system via `next-themes`).

No Supabase, no auth, no persistence, no Server Actions.

## Phase 2 — Data architecture & security design ✅ complete (this phase)

Documentation only — no code, no SQL, no packages, no Supabase project. Produced:

- This file, replacing the informal phase numbering scattered in code comments.
- [docs/database-schema.md](docs/database-schema.md) — tables, columns, constraints, indexes,
  DTO/DAL mapping.
- [docs/rls-policies.md](docs/rls-policies.md) — Row Level Security and object-privilege design.
- [docs/auth-design.md](docs/auth-design.md) — authentication model and defense-in-depth chain.

### Authoritative architectural decisions

- **Account balances are derived**, never stored as an independent scalar:
  `opening_balance_cents + SUM(ledger)`, exposed as a `security_invoker` view. The
  `Account.balanceCents` DTO is unchanged.
- **Single user, public signup disabled.** One user provisioned manually. Schema is still
  multi-tenant-correct (`user_id` + RLS on every table) so it never needs a later migration.
- **Ownership is enforced structurally**, via composite foreign keys
  (`FOREIGN KEY (x_id, user_id) REFERENCES x(id, user_id)`), not by trigger — holds under direct
  SQL access.
- **Movements are a parent table + exactly two nonzero legs summing to zero**, validated by a
  `DEFERRABLE` constraint trigger at `COMMIT`. Deleting the parent cascades both legs and is the
  only supported deletion path.
- **`goal_contributions` is append-only** (SELECT + INSERT only in the application API).
  `Goal.savedCents` is derived from the contribution ledger, never an editable scalar.
  Corrections are compensating signed rows, not edits or deletes.
- **Recurring bills are a `bills` + `bill_occurrences` model**, not a mutable `next_due_date`
  pointer — full history retained. `bill_occurrences.amount_cents` is `NOT NULL`, copied from
  `bills.amount_cents` at generation time — a fixed historical fact, not a live reference to the
  parent — so editing a recurring bill's amount later can never retroactively change a past
  occurrence's effective amount, paid or otherwise. The existing `Bill` DTO is preserved through
  the Phase 6 DAL swap by projecting the next unpaid occurrence into it; `BillOccurrence` doesn't
  reach the UI until Phase 7 needs occurrence history and payment actions.
- **Net-worth snapshots are stored monthly**, not derived, because a derived series needs a
  complete ledger back to account opening where any gap silently corrupts every point on the
  trend. **Each snapshot must be computed as-of its target month's last calendar day**, not from
  today's live account balances — required for regeneration, backfill, and retries to all produce
  the same result for the same month. Keyed by `PRIMARY KEY (user_id, month)`. Intended writer is
  `pg_cron`; documented fallback is idempotent on-demand generation.
- **Categories are per-user**, not a global shared table — keeps the RLS model uniform and
  supports future custom categories. Default categories are seeded for the one provisioned user.
- **`profiles` is 1:1 with `auth.users`**, holding an IANA `timezone` validated against
  PostgreSQL's `pg_timezone_names` catalog via trigger (not a regex, not a `CHECK`). Production
  `getToday()` derives the calendar date from this timezone, never the server's.
- **Money is `BIGINT` cents everywhere**, mapped through hand-written DAL mappers calling the
  existing `toCents()` safe-integer guard — reject invalid data, never silently coerce it. No
  Zod in this phase; reserved for the Phase 7 mutation/input-validation boundary.
- **RLS is SELECT-only for `authenticated` through Phase 6.** Write policies are added
  operation-by-operation in Phase 7, as each mutation is actually implemented — not in advance.
- **Object privileges (`GRANT`) and RLS are two separate layers**, both required: `GRANT`
  determines whether a role can attempt an operation at all; RLS then restricts which rows a
  permitted operation can touch. See [docs/rls-policies.md](docs/rls-policies.md).
- **Verified claims/user identity, never `getSession()`, for server-side authorization** —
  cookie-backed session data isn't itself a verified identity source. `getClaims()` is the
  recommended path for protecting pages and user data (proxy, layout guard); `getUser()` remains
  valid specifically when an up-to-date `Auth` user record is needed. `service_role` never runs in
  application code. See [docs/auth-design.md §5](docs/auth-design.md#5-verified-identity-never-getsession).

### Known future limitation — recorded now, not designed yet

The derived-balance model (`opening_balance_cents + SUM(ledger)`) assumes every balance change is
representable as a transaction. That breaks down for **investment market-value changes, loan-
interest accrual, and bank-reconciliation differences** — none of these are naturally an
income/expense/transfer. **Before bank synchronization or serious investment-account support is
built, the roadmap needs an auditable balance adjustment/reconciliation mechanism** that affects
the derived balance without counting as spending or income, preserves history, and never mutates
prior transactions merely to force a balance match. Not designed in Phase 2 — a stated
prerequisite for that future work, tracked here so it isn't forgotten.

## Phase 3 — Pre-persistence hardening ✅ complete

Pre-persistence hardening identified during the Phase 2 review, closed before the DAL swap.
Marked complete only after `lint`, `typecheck`, `test` (108 tests, up from the Phase 2 baseline
of 66), and `build` all passed against the changes below.

- **`error.tsx` / `loading.tsx` for `app/(app)/`, `not-found.tsx` at the app root.** One shared
  boundary per convention (not one per route) — `error.js`/`loading.js` wrap a segment's pages and
  nested layouts but not that segment's own `layout.js`, so `app/(app)/layout.tsx`'s sidebar and
  header stay mounted through both. No `global-error.tsx` (the root layout is a static shell and
  `global-error` replaces it, losing global styles/theme) and no `app/(app)/not-found.tsx` (no
  route calls `notFound()` — there are no dynamic routes yet).
- **DAL error taxonomy** (`lib/errors.ts`) — typed thrown errors, not a `Result<T, E>` type:
  `unauthorized`, `forbidden`, `not_found`, `data_integrity`, `unavailable`. A Server Component
  error reaches the client as a generic message + `digest` only (custom properties are stripped in
  production), so `error.tsx` cannot and does not branch on `code` — the taxonomy is for
  server-side translation (e.g. `not_found` → `notFound()`) once real failure sites exist. Phase 3
  ships the contract only; no route-level `try`/`catch` was added around today's fixture-backed
  calls, since there is nothing yet for them to catch.
- **Bounded transaction queries** — `TransactionFilters` (`lib/data/transactions.ts`) gained
  `from`/`to` (`CalendarDate`, both inclusive); `month` is now sugar for the equivalent
  `monthStart`/`monthEnd` range (new helpers in `lib/finance/dates.ts`), so there is one definition
  of "date range." Dashboard now requests only the current month; Analytics only its 6-month
  window; `getNetWorthHistory(6)` replaces the unbounded call in both.
- **Resolved the three previously-unused DAL functions**: deleted `getAccountById` and
  `getTransactionsForMonth` (superseded by `getTransactions({ from, to })`); kept `getUpcomingBills`
  and wired it into the Dashboard, replacing an unbounded `getBills()` + sort + slice.
- **Explicit ordering contracts** for every list-returning `lib/data/**` function — see
  `docs/database-schema.md §17`. Notably `getBudgets()` only guarantees a *technical* order
  (`category_id ASC`); the two visible consumers apply their own semantic order using category
  names they already fetch, not a UUID: `/budgets` sorts its list by `categoryName ASC` outright,
  while the Dashboard's budget section sorts by `utilization DESC` first and uses `categoryName
  ASC` only as the tie-break when utilization is equal — the Dashboard is not alphabetically
  ordered overall. `transactions.created_at` was added to the schema (§4/§17 of
  `docs/database-schema.md`) to give the transaction ordering contract
  (`date DESC, created_at DESC, id ASC`) a real tie-break — amending a doc that was already merged
  as part of Phase 2.
- `README.md` rewritten — orientation only, linking to `docs/**` rather than duplicating it.

### Deferred risks carried forward from Phase 3

- **`/transactions` remains intentionally unbounded** — a full-history browser with no pagination.
  Cheap against ~100 fixture rows; against real SQL it's an unbounded full-history read of the
  user's entire transaction history on every page load. **This is an explicit prerequisite for
  Phase 6**: bounded/paginated full-history browsing must be designed and built *before* the
  Supabase-backed `/transactions` route is considered production-ready for a large transaction
  history — see Phase 6 below.
- **Phase 5's auth guard will interact with `loading.tsx`.** Per the installed Next.js docs, if a
  layout reads runtime/uncached data (`cookies()`/`headers()`), `loading.tsx`'s Suspense fallback
  does not cover it and navigation blocks until the layout resolves. `app/(app)/layout.tsx` gains a
  `getClaims()` cookie read in Phase 5 — that check must stay fast, or move into its own nested
  `<Suspense>`, or the shared loading boundary added in Phase 3 will not show while auth resolves.

## Phase 4 — Supabase provisioning & migrations

Not yet started. Project creation, migrations implementing `docs/database-schema.md` and
`docs/rls-policies.md`, the movement `DEFERRABLE` constraint trigger, the timezone-validation
trigger, the `bill_occurrences` deletion-guard trigger, `security_invoker` views, `seed.sql`
generated from the existing fixtures (including the back-computed `opening_balance_cents`
arithmetic), and the hardened as-of snapshot-writer function. Must also settle the
snapshot-writer's database role/ownership, and each trigger's execution context (default vs
`SECURITY DEFINER`), as provisioning-time decisions (see
[docs/rls-policies.md](docs/rls-policies.md)).

## Phase 5 — Authentication

Not yet started. `lib/supabase/**` clients (browser/server/proxy), `proxy.ts` session refresh via
`getClaims()`, `(auth)/login` route, a verified-identity guard in `app/(app)/layout.tsx`. No
signup route — the one user is provisioned manually.

## Phase 6 — DAL swap

Not yet started. `lib/data/**` function bodies swap from fixtures to Supabase queries; existing
signatures, `lib/finance/**`, and all components are unchanged. Real `getToday()` reading
`profiles.timezone`.

**Prerequisite carried forward from Phase 3:** `/transactions` is a full-history browser with no
pagination or windowing. Before the Supabase-backed `/transactions` route is considered
production-ready for a large transaction history, this phase must design and build bounded/paginated
browsing for it — the unbounded `getTransactions()` call that page still makes fetches the user's
entire transaction history on every load, unlike every other route, which was bounded in Phase 3.

## Phase 7 — Mutations

Not yet started. Server Actions and forms, re-verifying auth and row ownership inside the DAL
(Server Actions are independently reachable endpoints). Narrowly-scoped write RLS policies and
object grants added per mutation as it's built. Zod introduced at this untrusted-input boundary.
`BillOccurrence` DTO and mark-as-paid UI. Goal-contribution INSERT UI.
