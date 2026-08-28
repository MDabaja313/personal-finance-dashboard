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

Checkpoints 1 and 2 are complete. **CP3 has not started.**

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
  account's history on any save. Revisit alongside the balance-adjustment/reconciliation work.
- **UI:** account management on `/accounts` (create disclosure, per-card edit, archive/unarchive);
  category management as one section of the existing `/settings` page — no new route and no settings
  sub-system, since a route built for one list would be dismantled the moment budgets and bills need
  managing. Plain `<form>` + `useActionState` throughout; no form library.
- **`npm run test:mutations`** (`vitest.mutations.config.ts`, `tests/mutations/**`) — the integration
  harness. Rebuilds the local database, signs in as the real owner, and drives the real Server
  Actions, mutation DAL, and production read DAL; mocks only `lib/data/supabase.ts` plus
  `next/cache`/`next/navigation`, and records those two rather than no-oping them so revalidation
  targets are asserted. Refuses to run against a non-loopback URL. Serial.

### Remaining — CP3 onward, not started

Every other finance domain is still read-only, and its grants and policies land only alongside the
feature that needs them: transactions, transfers/credit-card payments, budgets, bills/occurrences
(including the `BillOccurrence` DTO and mark-as-paid UI), goals/contributions (INSERT only,
respecting the append-only model), and reconciliation/adjustments where designed. The same rules
hold throughout — Server Actions are independently reachable endpoints, so the unconditional
`getOwnerId()` pattern Phase 6 established for reads applies to every write; narrowly-scoped write
RLS policies and object grants are added per mutation as it's built; §3/§4 of
`docs/rls-policies.md` records the intended eventual policy matrix.
