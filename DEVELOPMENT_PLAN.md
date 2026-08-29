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

## Phase 4 — Supabase provisioning & migrations ✅ complete

Project provisioned, both locally and hosted. Eight migrations implement
`docs/database-schema.md` and `docs/rls-policies.md` in full: the movement `DEFERRABLE`
constraint trigger, the timezone-validation trigger, the `bill_occurrences` deletion-guard
trigger, both `security_invoker` views, deterministic seed data, the bill-recurrence generator,
and the hardened as-of snapshot-writer function. **UI remains mock-backed** — no application
Supabase SDK/client exists yet (`lib/supabase/**` doesn't exist), no auth, no persistence, no
Server Actions. Phase 5 (Authentication) is next.

### Database

- Local PostgreSQL 17.6 (Supabase CLI 2.115.0); hosted PostgreSQL 17.6.
- 8 migrations (`supabase/migrations/20260822150001`–`...150008`), applied locally and remotely.
  Hosted migration history matches local exactly.
- Hosted database intentionally contains **zero application/auth rows** after Phase 4 — no
  provisioned user, no seed data. Provisioning the one real user is Phase 5 scope.
- The deterministic fixture-derived seed (`supabase/seed.sql`, generated by
  `scripts/generate-seed.ts` via `npm run seed:generate`) is **local-only** — never applied by
  `supabase db push`, only by `supabase db reset`.

### Security

- `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` on all 11 tables
  (`20260822150006_rls_and_grants.sql`).
- `authenticated` holds `SELECT` on 10 of the 11 tables/views. **`movements` is deliberately
  excluded** — no grant and no policy — through Phase 6; it's an internal integrity parent with
  no read path (`Transaction.movementId` is a plain column, nothing joins to `movements`). Phase 7
  adds the grant/policy only if movement mutation behavior actually needs it.
- `anon` holds zero grants on any user-financial table or view.
- Both views (`account_balances`, `goal_balances`) are declared `WITH (security_invoker = on)`.
- The `private` schema (system-internal functions and roles) is not in `supabase/config.toml`'s
  `[api] schemas` — not API-exposed — and has no `USAGE` grant for `anon`/`authenticated` at all,
  independent of any function-level `EXECUTE` state.

### Writer design — Option B (approved at Gate 3)

- `finance_snapshot_writer`: a dedicated system role, `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`,
  `NOCREATEDB`, `NOCREATEROLE` — narrowly privileged, not a bypass-RLS shortcut.
- It owns the 3 `SECURITY DEFINER` system functions
  (`private.generate_bill_occurrences`, `private.write_net_worth_snapshot`,
  `private.write_net_worth_snapshots_for_range`) and receives per-object grants (`SELECT` on
  `bills`/`accounts`/`transactions`, `SELECT`+`INSERT` on `bill_occurrences`,
  `SELECT`+`INSERT`+`UPDATE` on `net_worth_snapshots`) plus matching role-targeted RLS policies —
  both layers, since `NOBYPASSRLS` means `FORCE ROW LEVEL SECURITY` still applies to it.
- `PUBLIC`, `anon`, `authenticated`, and `service_role` do **not** have `EXECUTE` on any of the 3
  system functions.
- `postgres` (the migration/reset role) is a **member** of `finance_snapshot_writer` — enough to
  manage (`ALTER FUNCTION ... OWNER TO`, etc.) writer-owned objects across migrations, without
  granting `postgres`'s own `BYPASSRLS` attribute to the writer role — measured directly against
  the local database, `postgres` itself is `NOSUPERUSER`/`BYPASSRLS`, not a superuser.
- No `cron.schedule()` call anywhere in Phase 4 — these migrations settle and prove the privilege
  model only; scheduling is out of scope until it's actually needed.

### FK decision D10 — final approved behavior

Every restrict-style financial-history foreign key uses
`ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED`, never `RESTRICT` — `RESTRICT` is
non-deferrable, and a non-deferrable check can fail mid-cascade during a whole-user teardown
(`ON DELETE CASCADE` from `profiles` fires as separate per-child-table statements in an
order the migration doesn't control). Deferring to `COMMIT` preserves the same
hard-delete protection while letting a full user teardown succeed.

- `goal_contributions -> goals` uses this `NO ACTION DEFERRABLE` behavior — goals are
  soft-deleted (`archived_at`) and contribution history must never be silently destroyed by a
  hard delete of the parent goal.
- `movements -> transactions` (via `transactions.movement_id`) remains the intentional
  **cross-entity `ON DELETE CASCADE`** — the one and only supported movement-deletion path.
- **No `ON DELETE SET NULL` anywhere in this schema** — unchanged from the Phase 2 design.

### Function privileges — the verified default-privilege conclusion

PostgreSQL's built-in initial privilege grants `EXECUTE` to `PUBLIC` on every new function, and a
per-schema `ALTER DEFAULT PRIVILEGES ... IN SCHEMA private REVOKE ...` cannot remove that
built-in global default — confirmed empirically against the actual local Postgres 17.6 image
(migration 1's header comment records the direct test). The corrected posture, implemented in
`20260822150001_privilege_baseline.sql`:

- A **global-scope** (no `IN SCHEMA`) `ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE
  ON FUNCTIONS FROM PUBLIC` — this is what actually locks down new functions in both `public` and
  `private`.
- This is a defense-in-depth layer, **not the sole protection**: every sensitive function still
  gets its own direct, per-function `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated`
  immediately after `CREATE FUNCTION`, kept unconditionally regardless of the default-privileges
  configuration — so the intended posture is verifiable per-function, not inferred from
  migration ordering. **Do not rely on schema-scoped default ACLs alone.**

### BIGINT / PostgREST — empirical Phase 4 findings

- `BIGINT` columns serialize through local PostgREST as **unquoted JSON numbers** — confirmed for
  ordinary table columns and for the two view-computed columns,
  `account_balances.balance_cents` and `goal_balances.saved_cents`.
- PostgreSQL/PostgREST preserved `9007199254740993` **exactly** in the JSON payload; it's
  JavaScript's `JSON.parse` that rounds it, because that value exceeds
  `Number.MAX_SAFE_INTEGER`.
- The existing `Number.isSafeInteger`/`toCents()` boundary guard (`lib/types/index.ts`) already
  rejects the resulting unsafe value rather than silently coercing it — no mapper change was
  needed to make this safe.
- **This was one empirical boundary test, not a proof for every out-of-range value** — treat it as
  evidence the existing guard is doing its job, not as a substitute for the guard.
- `SUM(bigint)` returns `numeric` in PostgreSQL — both `account_balances` and `goal_balances` cast
  back to `::bigint` explicitly (`20260822150005_views.sql`) to preserve the `BIGINT` schema
  contract and keep the downstream wire type stable.

### Testing

- Deterministic local seed verified against the fixture-coherence invariants it's designed to
  reproduce.
- 10 pgTAP files (`supabase/tests/database/000`–`090`), **242/242 database assertions pass**.
- 108/108 Vitest tests pass — unchanged from the Phase 3 baseline, since Phase 4 added no
  application code, only SQL migrations and documentation.
- `lint`, `typecheck`, and `build` all pass.
- Full user teardown, recurrence (`private.next_bill_occurrence_date` /
  `generate_bill_occurrences`), historical as-of snapshot, and writer-privilege tests all pass.

### Hosted verification

All of the following were checked directly against the hosted project, not assumed from local
behavior:

- All 8 migrations applied successfully.
- All 11 hosted tables have `ENABLE` + `FORCE` RLS.
- `anon` has zero financial grants.
- `authenticated` cannot `SELECT` `movements`.
- Both views have `security_invoker = on`.
- `finance_snapshot_writer`'s attributes match the local design exactly.
- Privileged function ACLs and ownership match the local design.
- The `private` schema is unavailable to application roles.
- Hosted `public.*` tables and `auth.users` are both empty — no application or auth rows.
- Public signup is disabled at the project level.
- Hosted security checks are clear.

## Phase 5 — Authentication ✅ complete

`lib/supabase/**` clients (browser/server/proxy), `proxy.ts` session refresh via `getClaims()`,
`lib/auth/**` as the app-facing identity/Server Action facade, `(auth)/login`, and a
verified-identity guard in `app/(app)/layout.tsx`. No signup route — the one user is provisioned
manually, both locally and hosted. **UI remains mock-backed** — `lib/data/**`, `lib/mock/**`, and
`lib/finance/**` are untouched by this phase; Phase 6 is next.

Delivered across four checkpoints:

- **A1 — Supabase auth foundation.** `lib/supabase/env.ts` (the sole reader of
  `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`), `lib/supabase/client.ts`
  (browser), `lib/supabase/server.ts` (Server Components/Actions, async `cookies()`),
  `lib/supabase/proxy.ts` + root `proxy.ts` (session-cookie refresh via `getClaims()` on every
  navigation — not an authorization boundary, see `docs/auth-design.md §6`).
- **A2 — Owner authentication and provisioning.** `lib/auth/types.ts`, `lib/auth/actions.ts`
  (`signIn`/`signOut` Server Actions — no `signUp`, ever), `lib/auth/session.ts`
  (`getVerifiedClaims()`/`requireUser()`, both `getClaims()`-based, never `getSession()`),
  `app/(auth)/login`, `components/auth/login-form.tsx`. Provisioning tooling:
  `scripts/seed-identity.ts` (the one shared deterministic owner UUID),
  `scripts/provision-owner.ts` (`npm run auth:reset-local` — Auth Admin API creates the real local
  owner at that UUID, then the fixture seed attaches to it), `supabase/provisioning/owner.sql`
  (hand-run, hosted-only, idempotent).
- **A3 — Route protection.** `app/(app)/layout.tsx` calls `requireUser()` as the single guard
  point for every route under `app/(app)/`; `components/layout/header.tsx` renders the signed-in
  email and a `signOut` form.
- **A4 (this checkpoint) — Tests, runtime verification, documentation.**
  `lib/auth/actions.test.ts` (generic-login-error-mapping unit tests — a raw Supabase/Auth error
  never reaches the caller, only the fixed message);
  `lib/auth/posture.test.ts` (static regression test: no executable `getSession()`/`signUp()`
  call site, no signup route, `app/**`/`components/**` never import `lib/supabase/**`,
  `components/**` never imports `lib/auth/**` at the value level, only `lib/auth/**`/
  `lib/supabase/**`/root `proxy.ts` import `lib/supabase/**`, no service-role/admin secret in
  application source, signup disabled in `supabase/config.toml`); `scripts/verify-auth.ts`
  (`npm run auth:verify` — proves the full flow over real HTTP against a running dev server:
  logged-out redirect, login-page rendering, generic-error-only rejection, successful sign-in,
  session-cookie issuance, authenticated access across two different routes, authenticated
  `/login` redirect, logout cookie clearing, and post-logout inaccessibility — using the same
  progressively-enhanced `<form>` POST a JS-disabled browser would send, not a shortcut around
  Next.js Server Actions). Expired-access-token refresh is **not** runtime-proven by that script —
  documented as an explicit gap, resting on the proxy's use of the official Supabase SSR
  `getClaims()`-refresh pattern rather than an independent runtime check.

**Phase 6 prerequisite, resolved:** `npm run auth:reset-local` produces a real, login-capable local
owner at the exact same deterministic UUID (`scripts/seed-identity.ts`'s `SEED_USER_ID`) that
`supabase/seed.sql` attaches every fixture-derived financial row to — so the Phase 6 DAL swap has a
real authenticated session and real seeded data addressing the same user from day one, with no
separate reconciliation step.

## Phase 6 — DAL swap ✅ complete

All ten production `lib/data/**` read functions swapped from fixtures to Supabase queries with
unchanged signatures: `getAccounts`, `getCategories`, `getTransactions`, `getRecentTransactions`,
`getBudgets`, `getBills`, `getUpcomingBills`, `getGoals`, `getNetWorthHistory`, `getToday`.
`lib/finance/**` and every component are untouched — only `lib/data/**` bodies and one new file,
`lib/data/supabase.ts`, changed. `lib/mock/dal.ts` is retained as the `npm run test:parity` oracle
only; no production code imports it.

### Architecture

- `lib/data/supabase.ts` is the **one** DAL seam allowed to import `lib/supabase/**` — enforced by
  both `eslint.config.mjs` (`no-restricted-imports` over `lib/data/**`, exempting exactly this
  file) and the static allowlist in `lib/auth/posture.test.ts`. It exposes `getDataClient()` (one
  Supabase client per request, `React.cache`-scoped) and `getOwnerId()`.
- **Every Supabase-backed read calls `getOwnerId()` — verified via `getClaims()`, never
  `getSession()` — before issuing its query, unconditionally.** This does not depend on
  `app/(app)/layout.tsx`'s navigation guard having run first: a Server Action is an independently
  reachable endpoint that never renders a layout, and React may run layout and page work
  concurrently. Each read also carries an explicit `user_id`/`owner_id` predicate on top of RLS —
  defense in depth, not a substitute for it. Authenticated RLS (Phase 4) remains the enforced
  floor regardless of any DAL-level filter bug.
- `getAccounts()`/`getGoals()` read the `account_balances`/`goal_balances` `security_invoker`
  views (derived balances, never a stored scalar).
- `getBills()` is a two-query projection — active `bills`, then their `scheduled`
  `bill_occurrences` — reduced to one occurrence per bill in TypeScript, because PostgREST's
  embedded-resource `order`/`limit` applies to the flattened join rather than per parent row, so it
  cannot express "the first occurrence of each bill."
- `getTransactions()` orders `date DESC, created_at DESC, id ASC` (docs/database-schema.md §17)
  and is never called unbounded from the UI: `/transactions` reads a **bounded, cumulative
  "Load more" reveal window** — each press increases a `revealed` count by `PAGE_SIZE` (25); the
  page re-reads `offset: 0, limit: revealed + 1` (the `+1` a has-more probe row, never rendered) as
  one contiguous read of one ordering, split into consecutive `MAX_TRANSACTION_LIMIT`-sized DAL
  queries so no single query is unbounded. There is no reveal-depth ceiling, only a ceiling on any
  one underlying query's size. Changing a filter resets `page` client-side, so a new filter always
  starts from the first window. This closes the Phase 3 deferred risk below.
- `getNetWorthHistory()` queries `ORDER BY month DESC` + `LIMIT n` (only for `months > 0`) and
  reverses the result in TypeScript for chronological (ASC) display — `months === 0` returns full
  history, matching the fixture oracle's `slice(-0)` behavior.
- `getToday()` derives the calendar date from the verified owner's `profiles.timezone` via the real
  clock (`lib/data/clock.ts`, `calendarDateInTimeZone`) — **no dev-only `MOCK_TODAY` branch in
  production.** Seeded fixture data ages out of "this month" as real time advances; every page
  already has an empty state for that, and a clock that behaves differently in dev would be a
  clock nothing could be verified against.
- `public.movements` was not needed by any Phase 6 read — `Transaction.movementId` is a plain
  FK-backed column on `transactions` itself, so its Phase 4 posture (no `authenticated` grant, no
  RLS policy) is unchanged. A transfer/credit-card-payment pair's two legs remain independently
  visible through the ordinary `getTransactions()` path, scoped by each leg's own `account_id`.
- Every BIGINT cents value crossing the DB→TS boundary passes through `toCents()`
  (`Number.isSafeInteger` guard) — reject invalid data, never silently coerce it.

### Deferred, not a Phase 6 blocker

- **`merchant` search has no `pg_trgm` index.** `TransactionFilters.search` runs as
  `ILIKE '%…%'` with escaped wildcards (`lib/data/transactions.ts`, `lib/data/filters.ts`),
  verified correct against the single-owner seeded dataset. Recorded as a **future performance
  optimization** — add `pg_trgm` + a GIN index only if search latency actually becomes a problem
  at realistic per-owner row counts; no migration for it shipped in Phase 6.
- **Wildcard-escaping test coverage is asymmetric, deliberately.** `escapeLikePattern` is unit
  tested offline (`lib/data/filters.test.ts`) for every escaping rule, and the parity suite
  DB-proves the *negative* case — a literal `%`/`_`/`*` in a search term does not widen the match
  to unrelated merchants. The *positive* case — searching for a literal `%`, `_`, or `*` that
  actually appears in a merchant name — is not proven end-to-end against a live query, because the
  seed data contains no such merchant. Deliberately not fixed by contaminating seed data solely to
  close this test gap.

### Testing

- 264/264 Vitest tests pass offline (`npm test`), unchanged in kind from earlier phases but now
  covering `lib/data/**` unit tests too.
- 74/74 parity tests pass (`npm run test:parity`) — every Supabase-backed `lib/data/**` function
  checked against the `lib/mock/dal.ts` fixture oracle, against a real local Supabase instance.
- 242/242 pgTAP assertions pass (`npm run db:test`) — unchanged from Phase 4, since no migration
  shipped in Phase 6.
- `lint`, `npx next typegen`, `typecheck`, and `build` all pass.
- `npm run auth:verify` passes against a running dev server.
- Manually verified at runtime, authenticated: all 8 routes (`/dashboard`, `/accounts`,
  `/transactions`, `/budgets`, `/bills`, `/goals`, `/analytics`, `/settings`) render without an
  error boundary; `/transactions`' initial read and each "Load more" press stay bounded and
  cumulative; a filter change resets the reveal window; account/goal derived balances render with
  no `NaN`; transfer and credit-card-payment legs remain visible in transaction history; signing
  out re-protects every route.

### Prerequisite carried forward from Phase 3 — resolved

`/transactions` was a full-history browser with no pagination or windowing. The bounded,
cumulative "Load more" reveal window described above resolves this — no route makes an unbounded
`getTransactions()` call.

## Phase 7 — Mutations 🚧 in progress

Checkpoints 1 through 5 are complete. **CP5 was the REAL-FINANCE GATE, and it passes** — see
its section below. **CP6 has not started.**

### CP1 — Write foundation ✅ (no migration, no write grant, no mutating code)

The reusable pieces every later checkpoint builds on: `lib/validation/**` (Zod at the untrusted-input
boundary — `parseMoneyToCents` never constructs a float, `zNotFuture(today)` takes `today` as a
parameter), the `ActionState`/`attempt()` contract (`lib/actions/**`, with a fixed six-sentence
message table and no `NEXT_*` digest inspection), `mapWriteError()` plus the `conflict`/
`invalid_input` error codes, the enum label sets in `lib/types/enums.ts`, and the ESLint fences
around all of it — proven to actually fire by `lib/write-posture.test.ts`, which lints negative
probes through the repo's real config rather than trusting the config to be correct.

### CP2 — Accounts + categories ✅

**The owner can create, edit, and archive/unarchive accounts and categories. Nothing else became
writable.**

- **One additive migration**, `20260827120001_account_category_writes.sql`. No Phase 4 migration was
  edited. It grants `authenticated` **column-scoped** `INSERT`/`UPDATE` on exactly `accounts` and
  `categories`, adds four operation-specific RLS policies (`INSERT … WITH CHECK`,
  `UPDATE … USING + WITH CHECK`), and creates two `BEFORE UPDATE` guard triggers. **No `DELETE`
  grant anywhere, no `FOR ALL` policy anywhere, and `anon` is not named once.** The column lists and
  their rationale are in [docs/rls-policies.md §3](docs/rls-policies.md).
- **`accounts_guard_update()`** — type immutable; `opening_balance_cents` editable only while the
  account has zero transactions (it is the only stored balance figure, so editing it later restates
  history, including written snapshots); archiving requires a **derived** balance of exactly zero,
  while unarchiving is unconditional.
- **`guard_category_kind_change()`** — `kind` is immutable once the category is referenced by any
  `transactions`, `budgets`, or `bills` row; rename and archive stay available. This is a database
  invariant because `authenticated` now holds a direct `UPDATE (kind)` privilege, and `kind` is what
  separates income from spending in every rollup.
- **Layering:** `lib/actions/{accounts,categories}.ts` validate, run the mutation inside `attempt()`,
  turn `unauthenticated` into `redirect("/login")`, and revalidate precisely (`/accounts`,
  `/dashboard`, `/analytics`; `/transactions`, `/budgets`, `/dashboard`, `/analytics`) — never
  `revalidatePath("/")`. `lib/data/mutations/**` is the only layer issuing PostgREST writes, never
  takes an owner id from its caller, and is fenced away from `next/navigation`/`next/cache`.
- **Read-side change:** `Category` gained `isArchived`. Read *semantics* are unchanged — archived
  categories are still returned, because they resolve the labels on historical transactions — the
  flag simply became visible so a management view can show it and a future entry picker can hide it.
- **Deliberate limitation:** the account edit form's opening-balance field is optional and blank
  means "unchanged". `Account` exposes the *derived* balance, not the stored opening figure, and
  widening the DTO would force the fixture oracle to invent the seed's back-computed opening
  balances. Prefilling with the derived balance would be worse: it would silently restate an
  account's history on any save. **Revisited in CP5, and the conclusion held:** reconciliation is
  the right mechanism for "this balance is wrong", because it appends a dated correction instead of
  restating history, so the opening-balance field stays exactly as CP2 left it.
- **UI:** account management on `/accounts` (create disclosure, per-card edit, archive/unarchive);
  category management as one section of the existing `/settings` page — no new route and no settings
  sub-system, since a route built for one list would be dismantled the moment budgets and bills need
  managing. Plain `<form>` + `useActionState` throughout; no form library.
- **`npm run test:mutations`** (`vitest.mutations.config.ts`, `tests/mutations/**`) — the integration
  harness. Rebuilds the local database, signs in as the real owner, and drives the real Server
  Actions, mutation DAL, and production read DAL; mocks only `lib/data/supabase.ts` plus
  `next/cache`/`next/navigation`, and records those two rather than no-oping them so revalidation
  targets are asserted. Refuses to run against a non-loopback URL. Serial.

### CP3 — Ordinary transactions ✅

**The owner can now create, edit, and delete ordinary income, expense and refund transactions.
Transfers, card payments and adjustments remain uncreatable and unedatable, and nothing else
became writable.**

- **Two additive migrations, and the split between them is forced, not stylistic.**
  `20260828120001_transaction_kind_adjustment.sql` contains exactly one statement —
  `ALTER TYPE public.transaction_kind ADD VALUE 'adjustment'` — because a label added that way is
  unusable in the transaction that adds it, and the Supabase CLI applies each migration file in
  its own transaction. `20260828120002_transaction_writes.sql` then references `'adjustment'`
  freely in a `CHECK`, in two policy predicates and in a trigger body. No Phase 4 or CP2 migration
  file was edited; CP3 does drop and re-create `transactions_sign_by_kind_ck` with a wider
  predicate, in its own forward migration, with every existing branch preserved verbatim.
- **Grants.** Column-scoped `INSERT` (`id`, `user_id`, `account_id`, `date`, `merchant`, `kind`,
  `category_id`, `movement_id`, `amount_cents`) and `UPDATE` (`account_id`, `date`, `merchant`,
  `kind`, `category_id`, `amount_cents`) on `transactions`, plus the schema's **first `DELETE`
  grant** — on `transactions` and nothing else. `created_at` is in neither list (it is the
  same-day ordering tie-break); `id`, `user_id` and `movement_id` are `INSERT`-only. `anon` is
  not named once. Full rationale in [docs/rls-policies.md §3](docs/rls-policies.md).
- **Policies.** `transactions_insert_own`, `transactions_update_own_ordinary`
  (`USING` **and** `WITH CHECK`, each carrying `movement_id IS NULL AND kind <> 'adjustment'`),
  and `transactions_delete_own_non_movement` (`movement_id IS NULL`). Those two extra clauses are
  what make a movement leg unreachable from the ordinary surface and an adjustment non-editable
  in *both* directions — an existing one cannot be targeted, and an ordinary row cannot be
  retyped into one. Adjustment `DELETE` is deliberately left possible so CP5 can reconcile by
  delete-and-rewrite.
- **`assert_transaction_refs()`** — a `BEFORE INSERT OR UPDATE` trigger carrying the four
  cross-row rules no grant, `CHECK` or policy can express: **no row dated later than the owner's
  own calendar day** (`(now() AT TIME ZONE profiles.timezone)::date` — the same source
  `getToday()` reads, never server UTC); no archived account; an active, kind-compatible category
  when one is present; and no category on an adjustment. It covers movement legs too, so CP4
  inherits the protection rather than having to remember it.
- **Sign is derived, never submitted.** The form collects a non-negative magnitude and
  `signedAmountFor(kind, magnitude)` (`lib/types/enums.ts`, mirroring
  `transactions_sign_by_kind_ck`) produces the stored value. A signed field would let a
  well-formed submission contradict its own kind. Zero stays exactly `0`.
- **Creation is idempotent by client-generated UUID.** Ordinary transaction entry is the first
  operation here where a double submit produces a *real* duplicate, so the create form mints one
  key per mounted form and posts it as the row's `id`; a retry collides on the primary key.
  `createTransaction` does **not** treat that `23505` as success: it re-reads its own row and
  compares the complete normalized payload — exact match is a successful retry, the same key with
  a different payload is a `conflict`, and a key belonging to another owner (invisible through
  RLS) falls through as the ordinary unique conflict it is. No idempotency table, no middleware.
- **Revalidation** is exactly `/transactions`, `/dashboard`, `/accounts`, `/budgets`,
  `/analytics` — every route that reads the ledger, a derived balance, or a category rollup.
- **`adjustment` is read-side only.** The DTO union, the `/transactions` kind filter, and the
  badge all handle it; nothing can create one. `lib/finance/transactions.ts` counts it as neither
  spending nor income. Reconciliation is CP5.
- **UI:** an "Add transaction" sheet on `/transactions`, per-row Edit (same sheet) and a two-step
  inline Delete confirmation — rendered only for ordinary rows. Movement legs and adjustments
  stay fully visible in history and get no controls at all rather than disabled ones. Pickers
  offer active accounts and active categories only, narrowed to the kinds the selected
  transaction kind permits, with "Uncategorized" still legal. URL filtering, search and the
  cumulative "Load more" reveal are unchanged.
- **Deliberate limitation:** deleting a transaction whose account is archived is refused by the
  mutation layer only — the `DELETE` policy is about *rows*, not account state — and that is
  recorded in `lib/data/mutations/transactions.ts` rather than implied. It is the one CP3 rule
  without a database backstop.

### CP4 — Transfers + credit-card payments ✅

**The owner can now create, edit and delete transfers and credit-card payments, atomically, as
movements. Nothing else became writable, and the ordinary transaction surface is unchanged.**

- **One additive migration**, `20260828120003_movement_writes.sql`. No earlier migration was
  edited and nothing was dropped or replaced — `validate_movement()` (Phase 4) and
  `assert_transaction_refs()` (CP3) are used exactly as they were left, and everything here is
  built to satisfy them rather than to work around them.
- **Grants.** `SELECT`, column-scoped `INSERT` (`id`, `user_id`, `kind`) and `DELETE` on
  `movements`. **No `UPDATE` grant and no `UPDATE` policy, permanently** — a `movements` row is
  `(id, user_id, kind)`, and changing `kind` in place would contradict every leg's own kind
  (`validate_movement()` assert 3). `SELECT` arrives now because the *edit* surface is the first
  thing that needs the parent; `id` is grantable because creation is idempotent by a
  client-generated UUID *and* because `replace_movement` re-creates the movement under its
  original id. `anon` is not named once. Three operation-specific policies,
  `movements_{select,insert,delete}_own`.
- **Two `SECURITY INVOKER` RPCs, and they are the *only* path — a structural fact, not a
  convention.** A movement is a parent plus exactly two legs, and the database refuses every
  partial form: a childless movement fails the deferred trigger at `COMMIT`, and a leg naming a
  movement that does not exist yet fails the **non-deferrable** composite FK immediately.
  PostgREST issues one statement per request, each in its own transaction, so no sequence of
  PostgREST calls can produce a movement at all. `public.create_movement` and
  `public.replace_movement` take no owner (it comes from `auth.uid()`), use `search_path = ''`
  with qualified names, and have `EXECUTE` revoked from `PUBLIC`/`anon` and granted to
  `authenticated` alone — the first and only such grant in this schema.
  `140-movement-writes.sql` proves each half of the impossibility claim directly.
- **Editing is delete-and-recreate under the original id, inside one transaction.** An edit can
  change the amount, the date, the kind and either account, and every one of those must land on
  both legs at once — two sequential updates would pass through a state where the pair does not
  sum to zero, and no statement can rewrite one leg anyway. A refused replacement leg aborts the
  whole transaction, so the original pair survives byte for byte. Deleting deliberately gets no
  function: it is one statement on the parent, and the cascade takes both legs.
- **`SECURITY DEFINER` was never needed**, and `replace_movement` composes `create_movement`
  rather than sharing a helper in `private` for exactly that reason: a `SECURITY INVOKER` body
  runs with the caller's privileges, and `authenticated` has no `USAGE` on `private`.
- **Sign, merchant and category are all derived, never submitted.** The form posts a positive
  magnitude and two account *roles*; the RPC writes `-magnitude`/`+magnitude`, so
  legs-sum-to-zero is true by construction. Leg labels ("Transfer to High-Yield Savings" /
  "Transfer from Everyday Checking") are composed in SQL from the movement's kind and the other
  account's name, so the pair is consistent by construction and no free text reaches a row a
  person cannot edit directly. Category is written as an explicit `null`. `movementLegAmountsFor`
  (`lib/types/enums.ts`) mirrors the sign rule in TypeScript, for the idempotency comparison only.
- **One account-type rule, no broader than the repository already states:** a credit-card
  payment's destination must be a `credit` account. Nothing constrains the *source*'s type —
  paying a card from cash, savings or another card are all legitimate.
- **Creation is idempotent by three client-generated UUIDs** (movement + both legs), minted once
  per mounted form. A retry collides on the movements primary key; `createMovement` re-reads its
  own movement and compares the **complete** normalized payload — kind, date, both accounts in
  their roles, both leg ids, and the magnitude. Exact match is a successful retry, same key with a
  different payload is a `conflict`, and a key belonging to another owner falls through as the
  ordinary unique conflict. `replaceMovement` short-circuits when the persisted state already
  equals the request, which matters beyond efficiency: a needless rewrite would give both legs a
  new `created_at` and silently reorder same-day history.
- **Revalidation is exactly `/transactions`, `/dashboard`, `/accounts`, `/analytics`.**
  `/budgets` is deliberately absent — `countsAsSpending` is an allowlist of `expense` and
  `refund`, so a movement leg is excluded **by kind**, not by sign and not by lacking a category.
- **Read side:** `lib/data/movements.ts` adds `getMovements(ids)` and a `Movement` DTO (kind,
  date, source/destination accounts, both leg ids, positive magnitude). It reads by *movement id*
  rather than by pairing two rendered rows, because `/transactions` renders a bounded reveal
  window and a movement's legs routinely straddle its edge — so an edit works even when the
  partner leg is thousands of rows further back.
- **UI:** a separate "Move money" sheet on `/transactions`, beside the unchanged "Add
  transaction". Edit and two-step Delete render on **exactly one** leg — the source (negative)
  one, chosen on the server from `getMovements()`'s own resolution — so a pair never grows two
  sets of controls and the destination leg gets none rather than disabled ones. The ordinary form
  still offers income/expense/refund only. URL filtering, search and "Load more" are untouched.
- **Deliberate limitation:** deleting a movement that touches an archived account is refused by
  the mutation layer only — the `DELETE` policy is about *rows*, not account state — the same
  single-layer rule `deleteTransaction` carries, and recorded in
  `lib/data/mutations/movements.ts` rather than implied.

### CP5 — Reconciliation + current-month snapshots ✅ **REAL-FINANCE GATE**

**The owner can now reconcile any active account's balance to an observed figure, and remove a
reconciliation to redo it. The current month's net-worth snapshot is maintained after every
balance-affecting write. Nothing else became writable.**

- **Two additive migrations**, `20260829120001_reconciliation.sql` and
  `20260829120002_current_snapshot.sql`. No earlier migration was edited, and — the headline —
  **no table grant for `authenticated` changed at all.** `100-write-grants.sql` still asserts the
  CP4 matrix column by column, unaltered. Reconciliation is a new *operation over CP3's existing
  privileges*: CP3 already granted `INSERT (…, kind, …)`, already made `adjustment` a legal
  stored kind, and already left adjustment `DELETE` possible on purpose. What it withheld was a
  path to writing one.
- **Reconciliation never rewrites history.** The person states what an account's balance
  actually is; `public.reconcile_account` derives `delta = desired − (opening + SUM(ledger))` **in
  SQL** and writes one `adjustment` row for exactly that delta, dated as of the day the
  observation was true. `opening_balance_cents` is deliberately *not* the mechanism — editing it
  restates every balance the account ever reported, which is why `accounts_guard_update()` freezes
  it. A zero delta writes **no row** and reports success.
- **The delta is computed in the database, not the client**, and that is correctness rather than
  tidiness: reading the balance in one request and posting the difference in another leaves a
  window where a transaction entered in another tab makes the adjustment silently wrong, with a
  row that looks perfectly well-formed. It is also what makes reconciliation **idempotent with no
  idempotency key** — unlike CP3 and CP4, a resubmission computes its delta against the balance
  the first submission already corrected, so it writes nothing.
- **Liability input is a magnitude, normalized server-side.** Credit and loan accounts ask
  "Amount currently owed" and take a non-negative figure; `lib/data/mutations/reconciliation.ts`
  negates it into the internal balance from the account's **stored** type, never from anything the
  client sent. Asset accounts take a signed actual balance, because an overdrawn current account is
  a real state. The RPC's parameter keeps exactly one meaning — the desired internal signed
  balance — so an overpaid card (a legitimately positive `credit` balance) stays expressible.
- **An adjustment is permanently uneditable and always removable by its owner.**
  `transactions_update_own_ordinary` refuses both to target one and to produce one;
  `transactions_delete_own_non_movement` never excluded them. So the correction path is
  remove-and-reconcile-again, and `deleteAdjustment` is a reconciliation-specific mutation that
  refuses anything that is not an owned, non-movement adjustment — it adds **no privilege**.
- **`public.refresh_current_net_worth_snapshot()` — the single `SECURITY DEFINER` in this whole
  application.** Everything CP2–CP5 added is otherwise `SECURITY INVOKER`. This one cannot be:
  `private.write_net_worth_snapshot` is owned by `finance_snapshot_writer`, `authenticated` has no
  `USAGE` on `private`, and `net_worth_snapshots` has no write grant for `authenticated` and never
  will. It is kept narrow by construction — **zero parameters** (so no owner and no month can be
  addressed), owned by the existing `NOLOGIN`/`NOSUPERUSER`/`NOBYPASSRLS` writer rather than by
  `postgres`, `search_path = ''`, `EXECUTE` revoked from `PUBLIC`/`anon`, and exactly one new
  privilege: column-scoped `SELECT (id, timezone)` on `profiles` behind a policy narrowed to the
  calling request's own row. The `CREATE ON SCHEMA public` that `ALTER FUNCTION … OWNER TO`
  requires is granted for that one statement and revoked immediately.
- **The month comes from the owner's profile timezone, never server UTC** — the same expression
  `assert_transaction_refs()` and `getToday()` use. The bridge reads the JWT `sub` through
  `private.request_owner_id()` rather than `auth.uid()`, because inside a definer body the current
  role is `finance_snapshot_writer`, which has no `USAGE` on schema `auth` — and that grant cannot
  be made from a migration at all (schema `auth` belongs to `supabase_auth_admin`; the migration
  role holds no `WITH GRANT OPTION`, and the statement reports *"no privileges were granted"*).
  Both facts were verified directly against the local image. `160-current-snapshot.sql` asserts
  `request_owner_id()` and `auth.uid()` agree for a set claim, an empty claim, and the JSON
  `request.jwt.claims` form, so the duplication cannot drift silently.
- **The refresh is a secondary failure, always.** It is a separate PostgREST request and therefore
  a separate transaction, so it is awaited *after* the primary write commits, and a failure is
  caught, logged as a sanitized noun plus an `AppErrorCode`, and swallowed — never allowed to
  report an already-committed ledger write as failed. `lib/data/mutations/snapshots.ts` is the
  only module in the codebase that names the bridge, and `lib/write-posture.test.ts` asserts that.
- **Which writes refresh, and which deliberately do not.** Refresh: account create, an
  opening-balance edit, archive/unarchive (the writer's inclusion rule is `is_archived = false`),
  ordinary transaction create/update/delete, movement create/replace/delete, reconciliation, and
  adjustment removal. No refresh: any category write, a metadata-only account edit (name,
  institution, credit limit, interest rate), a deduplicated create, a no-op movement replace, and a
  zero-delta reconciliation — all of which write nothing a snapshot column reads.
- **Revalidation** is exactly `/transactions`, `/dashboard`, `/accounts`, `/analytics`.
  `/budgets` is absent for the same reason it is absent from the movement routes: `countsAsSpending`
  is an allowlist of `expense` and `refund`, so an adjustment is excluded **by kind**.
- **UI:** "Reconcile balance" is a per-account disclosure on `/accounts`, beside Edit and mutually
  exclusive with it (the two ask contradictory questions about the same number — one restates
  history, the other appends a dated correction). It shows the current derived balance, defaults
  the date to the owner's today, asks the right question for the account's type, and says plainly
  that it creates a balance adjustment rather than spending. An archived account gets a sentence
  ("unarchive first to reconcile"), not a disabled button. On `/transactions`, an adjustment row
  gets a two-step **Remove** control whose confirmation says it changes the account's balance —
  and no Edit control at all.
- **Deliberate historical limitations, accepted rather than worked around:** no `opened_on`, no
  archived-at lifecycle reconstruction, no prior-month rebuild control, and no repair of an old
  monthly snapshot after a backdated edit. Live derived balances are authoritative; the snapshot
  series is a secondary trend. There is no historical rebuild *surface* either —
  `private.write_net_worth_snapshots_for_range` keeps its Phase 4 posture with no wrapper of any
  kind, and `160-current-snapshot.sql` asserts `public` exposes exactly one snapshot function.
- **Two inherited limitations, now reachable and therefore recorded.** Phase 4's
  `private.write_net_worth_snapshot` carries **two** sign guards — `v_assets_cents < 0` and
  `v_liabilities_cents < 0` — and raises `data_exception` (SQLSTATE 22000) **before writing
  anything** rather than storing either magnitude negative. Both were unreachable when they were
  written, because nothing could produce either state and nothing called the writer; CP4 and CP5
  changed both halves of that.
  - **Aggregate assets below zero** — the sum of every active non-`credit`/`loan` account. Reached
    by opening an account at a negative balance (the create form's own hint says the figure is
    signed, and no constraint restricts sign by type), by overdrawing one with an ordinary CP3
    expense, by transferring out of one, or by reconciling one to a negative observed balance,
    which CP5's asset form invites explicitly. The *aggregate* goes negative only when the owner's
    whole asset position does — one overdrawn current account and no savings, which is an ordinary
    personal-finance situation and the more likely of the two.
  - **Aggregate liabilities above zero internally** — a CP4 card payment larger than the card owes,
    with no other debt to offset it, or CP5 zeroing the debts that were offsetting one.

  In both cases the primary write **commits**, the action reports success, exactly one sanitized
  line is logged (`[invalid_input]` — 22000 is class 22; no figures and no raise text), and the
  existing snapshot row is left **byte for byte unchanged**: stale, never wrong. The next
  balance-affecting write that returns the aggregate to a valid sign recomputes the whole month, so
  the stale window is bounded by ordinary use. CP5 does not alter the Phase 4 writer; a future
  checkpoint that wants a signed aggregate must decide whether the `net_worth_snapshots`
  `CHECK (assets_cents >= 0 AND liabilities_cents >= 0)` is still the rule it wants — and that is a
  schema decision about what a snapshot *means*, not a bug fix.

### Remaining — CP6 onward, not started

Every other finance domain is still read-only, and its grants and policies land only alongside the
feature that needs them: budgets, bills/occurrences (including the `BillOccurrence` DTO and
mark-as-paid UI), and goals/contributions (INSERT only, respecting the append-only model). The
same rules hold throughout — Server Actions are independently reachable
endpoints, so the unconditional `getOwnerId()` pattern Phase 6 established for reads applies to
every write; narrowly-scoped write RLS policies and object grants are added per mutation as it's
built; §3/§4 of `docs/rls-policies.md` records the intended eventual policy matrix.
