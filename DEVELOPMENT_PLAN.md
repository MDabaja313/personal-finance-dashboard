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

## Phase 3 — Pre-persistence hardening

Not yet started. Blocking technical debt identified during the Phase 2 review, to close before
the DAL swap:

- `error.tsx` / `loading.tsx` / `not-found.tsx` for `app/**` — fixtures can't fail or be slow; a
  network round-trip to Supabase can do both, and today there is no boundary for either.
- **DAL error taxonomy** (typed thrown errors, not a `Result<T, E>` type — pages already rely on
  Next.js error boundaries): `unauthorized`, `forbidden`, `not_found`, `data_integrity`,
  `unavailable`. Raw database errors and financial values never reach user-facing messages.
- **Bounded transaction queries** — extend the existing `TransactionFilters`
  (`lib/data/transactions.ts`) with optional `from`/`to` `CalendarDate` bounds. Dashboard and
  Analytics currently fetch transactions unbounded and window them in JavaScript after the DAL
  read — both are Server Components, so this computation runs server-side today, but it's still a
  full result set fetched and filtered in-process rather than a bounded query, which becomes a
  full-table scan against SQL.
- Resolve the three currently-unused DAL functions (`getAccountById`, `getUpcomingBills`,
  `getTransactionsForMonth`) deliberately — drop or keep, not silently port.
- Explicit `ORDER BY` contracts for every list-returning DAL function (several rely on incidental
  fixture-array order today, which SQL will not preserve).
- Replace `README.md` boilerplate.

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

## Phase 7 — Mutations

Not yet started. Server Actions and forms, re-verifying auth and row ownership inside the DAL
(Server Actions are independently reachable endpoints). Narrowly-scoped write RLS policies and
object grants added per mutation as it's built. Zod introduced at this untrusted-input boundary.
`BillOccurrence` DTO and mark-as-paid UI. Goal-contribution INSERT UI.
