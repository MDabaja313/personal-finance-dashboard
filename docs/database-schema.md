# Database Schema Design

This design is now **implemented** — see `supabase/migrations/20260822150001`–`...150008` for the
executable SQL and [DEVELOPMENT_PLAN.md §Phase 4](../DEVELOPMENT_PLAN.md#phase-4--supabase-provisioning--migrations--complete)
for the verified completion facts (migration counts, hosted verification, test results). This
document remains the authoritative *design* narrative — the reasoning behind each decision — while
the migrations are the authoritative *executable* source; small illustrative SQL snippets below
predate the migrations and are kept only where they still clarify a shape or a constraint's intent,
not as a claim that they're what actually shipped. See
[DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md) for phase sequencing and
[docs/rls-policies.md](rls-policies.md) for security. **Phase 6 is complete** — all ten
production `lib/data/**` read functions (§16) are Supabase-backed. `lib/mock/dal.ts` remains only
as the parity-test oracle; no production code reads it (`eslint.config.mjs` and
`lib/auth/posture.test.ts`-style static checks keep it that way). No migration changed during
Phase 6 — the schema below is exactly what Phase 4 shipped.

## Contents

1. [Tables and relationships](#1-tables-and-relationships)
2. [Enums](#2-enums)
3. [Ownership model](#3-ownership-model)
4. [Table-by-table columns](#4-table-by-table-columns)
5. [Delete / archive behavior](#5-delete--archive-behavior)
6. [Constraints and cross-row invariants](#6-constraints-and-cross-row-invariants)
7. [The movement invariant in detail](#7-the-movement-invariant-in-detail)
8. [Indexes](#8-indexes)
9. [Money and BIGINT rules](#9-money-and-bigint-rules)
10. [Date and timezone rules](#10-date-and-timezone-rules)
11. [Derived account balances](#11-derived-account-balances)
12. [Goal contribution model](#12-goal-contribution-model)
13. [Recurring bill / occurrence model](#13-recurring-bill--occurrence-model)
14. [Net-worth snapshots](#14-net-worth-snapshots)
15. [DTO mapping](#15-dto-mapping)
16. [DAL function mapping](#16-dal-function-mapping)
17. [Fixture / invariant traceability](#17-fixture--invariant-traceability)
18. [Known future limitation — balance reconciliation](#18-known-future-limitation--balance-reconciliation)
19. [Bill payment provenance (Phase 8 CP1)](#19-bill-payment-provenance-phase-8-cp1)
20. [Monthly plans (Phase 8 CP2)](#20-monthly-plans-phase-8-cp2)

---

## 1. Tables and relationships

```
auth.users (Supabase)
   └─1:1─ profiles
            ├──< accounts ──────┐
            ├──< categories ─┐  │
            ├──< movements   │  │
            │       └──2 legs┼──┼──< transactions >── account_id
            │                │  │                 >── category_id (nullable)
            │                │  │                 >── movement_id (nullable)
            ├──< budgets ────┤  │
            ├──< bills ──────┘  │
            │      └──< bill_occurrences >── (optional) transaction_id
            ├──< goals
            │      └──< goal_contributions   [append-only]
            ├──< monthly_plans               [one per month; referenced by nothing]
            └──< net_worth_snapshots
```

**Twelve tables:** `profiles`, `accounts`, `categories`, `movements`, `transactions`, `budgets`,
`bills`, `bill_occurrences`, `goals`, `goal_contributions`, `net_worth_snapshots`, and — added by
Phase 8 CP2 — `monthly_plans` (§20).

**Two views**, both `security_invoker = on`, both implemented in
`20260822150005_views.sql`
(see [rls-policies.md](rls-policies.md#security_invoker-views)):

- `account_balances` — derived current balance per account.
- `goal_balances` — derived `saved_cents` per goal.

**Decided in Phase 4, shipped in Phase 6:** the bill next-unpaid-occurrence projection is **not** a
view — it is a two-query Phase 6 DAL projection (`lib/data/bills.ts`), per §13/§16.

No table list changed across the review rounds that produced this document — the balance-
reconciliation limitation (§18) is recorded as a *future* prerequisite, not a table added now.

---

## 2. Enums

| Enum | Values | Note |
|---|---|---|
| `account_type` | `checking`, `savings`, `cash`, `credit`, `investment`, `loan` | Matches `AccountType` in `lib/types/index.ts` |
| `transaction_kind` | `income`, `expense`, `refund`, `transfer`, `credit_card_payment`, `adjustment` | Matches `TransactionKind`. `adjustment` was appended by Phase 7 CP3 (`20260828120001_transaction_kind_adjustment.sql`) as its own migration — a label added by `ALTER TYPE … ADD VALUE` is unusable in the transaction that adds it, so the constraints and policies that reference it had to land in a second file. It is **readable but not writable**: the ordinary entry form offers `income`/`expense`/`refund` only, and the UPDATE policy refuses both to target an adjustment and to produce one (§6). Reconciliation, which is what will actually create them, is CP5 (§18) |
| `movement_kind` | `transfer`, `credit_card_payment` | **Deliberately narrower** than `transaction_kind` — makes "a movement can only be one of the two paired kinds" a type-level fact, not a runtime check |
| `bill_frequency` | `weekly`, `biweekly`, `monthly`, `yearly` | Matches `BillFrequency` |
| `category_kind` | `income`, `expense` | Matches `Category.kind` |
| `bill_occurrence_status` | `scheduled`, `paid`, `skipped` | Matches `BillOccurrenceStatus` |
| `bill_payment_origin` | `linked`, `generated` | **Phase 8 CP1** (`20260902120001_bill_payment_ledger.sql`). Matches `BillPaymentOrigin`. Unlike every other enum here, **no layer of this application ever writes one of these labels** — `public.settle_bill_occurrence` chooses it in SQL and `guard_bill_occurrence_transition()` refuses `'generated'` for any transaction not created by the same database transaction (§19) |

---

## 3. Ownership model

`profiles.id` is both primary key and `REFERENCES auth.users(id) ON DELETE CASCADE`, so
`auth.uid()` compares directly against `user_id` on every other table with no join required.

Every user-owned table carries:

```
user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE
```

**Cross-table ownership is enforced structurally, via composite foreign keys — not by trigger,
and not solely by RLS.** Every parent table declares a redundant `UNIQUE (id, user_id)`; every
child foreign key references that composite:

```
accounts:      UNIQUE (id, user_id)
transactions:  FOREIGN KEY (account_id, user_id)  REFERENCES accounts(id, user_id)
               FOREIGN KEY (category_id, user_id) REFERENCES categories(id, user_id)
               FOREIGN KEY (movement_id, user_id) REFERENCES movements(id, user_id)
```

This makes "a transaction may only reference *your* account/category/movement" a database fact
that holds under direct SQL access, independent of RLS. Applied uniformly to every parent/child
pair in the schema: `transactions`→`accounts`/`categories`/`movements`,
`bill_occurrences`→`bills`, `goal_contributions`→`goals`, `budgets`→`categories`, `bills`→
`categories`/`accounts` (both nullable FKs, same composite pattern when present).

`user_id` intentionally appears on **no DTO** — it is a database ownership concern, never
something the UI sees or passes.

---

## 4. Table-by-table columns

### `profiles`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `UUID` | NOT NULL, PK | `REFERENCES auth.users(id) ON DELETE CASCADE` |
| `timezone` | `TEXT` | NOT NULL, default `'UTC'` | IANA identifier; trigger-validated (§10) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, default `now()` | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, default `now()` | |

### `accounts`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `UUID` | NOT NULL, PK | |
| `user_id` | `UUID` | NOT NULL | FK → `profiles(id)` |
| `name` | `TEXT` | NOT NULL | |
| `institution` | `TEXT` | NOT NULL | |
| `type` | `account_type` | NOT NULL | |
| `opening_balance_cents` | `BIGINT` | NOT NULL | See §11 — the only stored balance figure |
| `credit_limit_cents` | `BIGINT` | **nullable** | Null = not applicable to this account type (§9) |
| `interest_rate_bps` | `INTEGER` | **nullable** | Null = not applicable |
| `is_archived` | `BOOLEAN` | NOT NULL, default `false` | |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, default `now()` | |
| — | | | `UNIQUE (id, user_id)` |

Current `balanceCents` is **not** a column — it's the `account_balances` view (§11).

### `categories`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `UUID` | NOT NULL, PK | |
| `user_id` | `UUID` | NOT NULL | FK → `profiles(id)` — **per-user, not global** |
| `name` | `TEXT` | NOT NULL | |
| `kind` | `category_kind` | NOT NULL | |
| `is_archived` | `BOOLEAN` | NOT NULL, default `false` | |
| — | | | `UNIQUE (id, user_id)`; case-insensitive per-user name uniqueness via a **unique expression index** on `(user_id, lower(name))` — see §8, not an ordinary column-list `UNIQUE` constraint |

### `movements`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `UUID` | NOT NULL, PK | |
| `user_id` | `UUID` | NOT NULL | FK → `profiles(id)` |
| `kind` | `movement_kind` | NOT NULL | |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, default `now()` | |
| — | | | `UNIQUE (id, user_id)` |

No amounts or dates live here — those belong to the two `transactions` legs (§7).

### `transactions`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `UUID` | NOT NULL, PK | |
| `user_id` | `UUID` | NOT NULL | FK → `profiles(id)` |
| `account_id` | `UUID` | NOT NULL | Composite FK → `accounts(id, user_id)` |
| `date` | `DATE` | NOT NULL | Calendar value — see §10 |
| `merchant` | `TEXT` | NOT NULL | |
| `kind` | `transaction_kind` | NOT NULL | |
| `category_id` | `UUID` | **nullable** | Composite FK → `categories(id, user_id)`. Null on movement legs, null on `adjustment` rows, *and* legally null on some ordinary rows — see `txn-094`, §17 |
| `movement_id` | `UUID` | **nullable** | Composite FK → `movements(id, user_id)`. Non-null iff `kind` is a movement kind (§6) |
| `amount_cents` | `BIGINT` | NOT NULL | Signed. Zero is legal for ordinary rows, illegal for movement legs (§6) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, default `now()` | **Phase 3 amendment.** Query-ordering only — never surfaced on the `Transaction` DTO. Added specifically because deterministic same-day transaction ordering required an entry-recency tie-break: without it, `ORDER BY date DESC, id ASC` alone would order tied rows by UUID, which carries no meaning a user could read. Exists so `ORDER BY date DESC, created_at DESC, id ASC` has a real entry-recency tie-break instead (§8, §17). |
| — | | | `UNIQUE (id, user_id)` — the composite target `bill_occurrences.transaction_id` references (§13) |

### `budgets`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `UUID` | NOT NULL, PK | |
| `user_id` | `UUID` | NOT NULL | FK → `profiles(id)` |
| `category_id` | `UUID` | NOT NULL | Composite FK → `categories(id, user_id)` |
| `period` | `TEXT` | NOT NULL | `'YYYY-MM'`, matches `MonthKey` |
| `limit_cents` | `BIGINT` | NOT NULL | |
| — | | | `UNIQUE (user_id, category_id, period)` |

### `bills`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `UUID` | NOT NULL, PK | |
| `user_id` | `UUID` | NOT NULL | FK → `profiles(id)` |
| `name` | `TEXT` | NOT NULL | |
| `amount_cents` | `BIGINT` | NOT NULL | The default/expected amount |
| `frequency` | `bill_frequency` | NOT NULL | |
| `anchor_date` | `DATE` | NOT NULL | The original due date recurrence derives from (§13) |
| `category_id` | `UUID` | nullable | Composite FK → `categories(id, user_id)` |
| `account_id` | `UUID` | nullable | Composite FK → `accounts(id, user_id)` |
| `is_archived` | `BOOLEAN` | NOT NULL, default `false` | |
| — | | | `UNIQUE (id, user_id)` |

### `bill_occurrences`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `UUID` | NOT NULL, PK | |
| `user_id` | `UUID` | NOT NULL | FK → `profiles(id)` |
| `bill_id` | `UUID` | NOT NULL | Composite FK → `bills(id, user_id)` |
| `due_date` | `DATE` | NOT NULL | |
| `status` | `bill_occurrence_status` | NOT NULL, default `'scheduled'` | |
| `amount_cents` | `BIGINT` | **NOT NULL** | Copied from `bills.amount_cents` **at generation time** — a concrete historical fact, not a live reference (§9, §13) |
| `transaction_id` | `UUID` | nullable | Composite FK → `transactions(id, user_id)`, `ON DELETE RESTRICT`. Nullable because an occurrence may be marked paid without any transaction at all (§13) |
| `transaction_origin` | `bill_payment_origin` | nullable | **Phase 8 CP1.** Where the reference came from: `'linked'` (the owner's own row, never deleted by this application) or `'generated'` (created by the settlement, removed by its reversal). Non-null exactly when `transaction_id` is — and unforgeable; see §19 |
| `paid_on` | `DATE` | nullable | |
| — | | | `UNIQUE (bill_id, due_date)` — makes generation idempotent; status-consistency `CHECK`s and the FK to `transactions` detailed in §13 |

### `goals`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `UUID` | NOT NULL, PK | |
| `user_id` | `UUID` | NOT NULL | FK → `profiles(id)` |
| `name` | `TEXT` | NOT NULL | |
| `target_cents` | `BIGINT` | NOT NULL | `CHECK (target_cents > 0)` |
| `target_date` | `DATE` | nullable | |
| `archived_at` | `TIMESTAMPTZ` | nullable | Soft-delete marker (§5) |
| — | | | `UNIQUE (id, user_id)` |

Current `savedCents` is **not** a column — it's the contribution rollup (§12).

### `goal_contributions`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `UUID` | NOT NULL, PK | |
| `user_id` | `UUID` | NOT NULL | FK → `profiles(id)` |
| `goal_id` | `UUID` | NOT NULL | Composite FK → `goals(id, user_id)` |
| `amount_cents` | `BIGINT` | NOT NULL | **Signed** — negative rows are withdrawals/corrections |
| `occurred_on` | `DATE` | NOT NULL | |
| `note` | `TEXT` | nullable | |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, default `now()` | |

**Append-only in the application API** — see §5, §12, and
[rls-policies.md](rls-policies.md#operation-specific-policies).

### `net_worth_snapshots`

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `user_id` | `UUID` | NOT NULL | FK → `profiles(id)` |
| `month` | `TEXT` | NOT NULL | `'YYYY-MM'`, same format constraint as `budgets.period` (§6) |
| `assets_cents` | `BIGINT` | NOT NULL | `CHECK (assets_cents >= 0)` |
| `liabilities_cents` | `BIGINT` | NOT NULL | Positive magnitude — `CHECK (liabilities_cents >= 0)` |
| `net_worth_cents` | `BIGINT` | NOT NULL | `CHECK (net_worth_cents = assets_cents - liabilities_cents)` |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, default `now()` | |
| — | | | **`PRIMARY KEY (user_id, month)`** — see §14 for why this replaces a separate surrogate key + `UNIQUE` |

Written only by the trusted snapshot mechanism — see §14 and
[rls-policies.md](rls-policies.md#snapshot-writer-security).

---

## 5. Delete / archive behavior

Governing rule: **financial history is never silently destroyed.** Soft-delete is the default;
hard delete is either blocked while referenced, or explicitly cascading — never quietly lossy.
**No `ON DELETE SET NULL` is used on any financial column anywhere in this schema** — a `SET
NULL` on, say, `transactions.category_id` would silently move historical spend into
"uncategorized" and change every past budget report that referenced it. The same reasoning
applies to `bill_occurrences.transaction_id → transactions(id, user_id)`: `RESTRICT` (or
equivalent `NO ACTION` semantics), never `SET NULL` — a transaction linked as an occurrence's
payment history must not silently vanish from that occurrence's record just because the
transaction row is deleted.

| Table | Policy | Rationale |
|---|---|---|
| `accounts` | Soft (`is_archived`). Hard delete `RESTRICT` while transactions reference it. | Balance is derived from the ledger; deleting the account would silently rewrite net worth. Archived accounts still render on `/accounts`. |
| `categories` | Soft (`is_archived`). Hard delete `RESTRICT` while referenced. | See the `SET NULL` rationale above. |
| `movements` | Hard delete, `ON DELETE CASCADE` to both legs. | The only deletion path for a movement — see §7's cascade handling. |
| `transactions` | Hard delete allowed for non-movement rows. Movement legs are deletable **only** via deleting the parent movement. | Direct leg deletion would break the two-leg invariant — rejected by the deferred trigger (§7). |
| `bills` | Soft (`is_archived`). Occurrences retained regardless. | The entire point of the occurrence model is retained history. |
| `bill_occurrences` | **Status-conditional delete, enforced by a dedicated deletion-guard trigger — not a plain `RESTRICT`, since eligibility depends on `status`, not on whether the row is referenced.** `scheduled` → delete allowed. `paid` or `skipped` → delete rejected. See §13 for the required trigger behavior. | A paid or skipped occurrence is history; only a still-pending scheduled occurrence is safe to remove. `authenticated` holds no DELETE grant on this table regardless (`rls-policies.md`), so this trigger is defense-in-depth for any privileged/direct-SQL path. |
| `goals` | Soft (`archived_at`). **All contributions are retained on archive.** | Locked decision — deleting a goal must not silently destroy its financial history. |
| `goal_contributions` | **No application DELETE, no application UPDATE — append-only.** | Corrections are compensating signed rows, not edits. Manual/administrative database correction remains possible outside the application path if absolutely necessary, but is **not part of the application API**. See §12. |
| `net_worth_snapshots` | Regenerable; written only by the trusted mechanism, never by `authenticated`. | Derived artifact — see §14. |
| `profiles` | `ON DELETE CASCADE` from `auth.users`. | Deleting the Supabase auth user removes all their data — expected privacy behavior. |

---

## 6. Constraints and cross-row invariants

### Single-row `CHECK` constraints

- `transactions`: `kind IN ('income','refund') → amount_cents >= 0`;
  `kind = 'expense' → amount_cents <= 0`; `kind = 'adjustment'` — **unconstrained in sign**.
  **Non-strict** — a legal fixture row has `amount_cents = 0` on an `expense` (§17). The
  adjustment branch was added by Phase 7 CP3, which dropped and re-created the constraint with
  every existing branch preserved verbatim (no Phase 4 migration was edited). An adjustment is
  whatever signed delta reconciles a derived balance to a real one, so a rule guessing its
  direction now would be a rule the reconciliation work has to fight; its integrity comes from
  being uncreatable and uneditable through the ordinary surface instead (§18).
- `transactions`: `kind = 'adjustment' → category_id IS NULL` (Phase 7 CP3). An adjustment
  corrects an account's *balance* rather than recording consumption, so a category on one would
  put a reconciliation difference into `spendingByCategory`, budget utilisation, and the
  income/expense split. One-directional, like the movement rule below.
- `transactions`: **`kind IN ('transfer','credit_card_payment') → amount_cents <> 0`.** Combined
  with "exactly two legs" and "legs sum to zero" (§7), this makes **opposite-signed legs a
  database guarantee**, not just a convention.
- `transactions`: `(kind IN ('transfer','credit_card_payment')) = (movement_id IS NOT NULL)` —
  biconditional. Delivers both "movement legs must reference a movement" and "ordinary
  income/expense/refund rows must not reference one" from a single constraint.
- `transactions`: `movement_id IS NOT NULL → category_id IS NULL`. **One-directional only** —
  the reverse is not required, because an ordinary row is legally allowed to have no category
  (§17).
- `accounts`: `credit_limit_cents IS NOT NULL → type = 'credit'`;
  `interest_rate_bps IS NOT NULL → type IN ('credit','loan')`; both `>= 0` when present.
- `budgets`: `limit_cents >= 0`; `period ~ '^\d{4}-(0[1-9]|1[0-2])$'`.
- `goals`: `target_cents > 0`.
- `net_worth_snapshots`: `assets_cents >= 0`, `liabilities_cents >= 0`,
  `net_worth_cents = assets_cents - liabilities_cents` — the convention documented in
  `lib/types/index.ts` for `NetWorthSnapshot` becomes an enforced database fact.
  `month ~ '^\d{4}-(0[1-9]|1[0-2])$'` — the same format constraint as `budgets.period`, above.
- `bill_occurrences` — status/payment-field consistency (all same-row, so expressible as `CHECK`,
  detailed further in §13):
  - `status = 'scheduled' → paid_on IS NULL AND transaction_id IS NULL`
  - `status = 'skipped' → paid_on IS NULL AND transaction_id IS NULL`
  - `status = 'paid' → paid_on IS NOT NULL`. `transaction_id` may be null or non-null when
    `paid` — a manually recorded payment has no linked transaction row, and that must stay legal.

### Deletion-guard trigger (§5, §13) — not a `CHECK`

`bill_occurrences` also needs a **cross-time** rule that a `CHECK` cannot express — deletion
eligibility depends on the row's `status` at delete time, which is a delete-operation guard, not
a same-row insert/update invariant. Specified in full in §13; noted here so the constraint list
and the trigger list aren't confused for one another.

### Write-guard triggers (Phase 7 CP2) — also not `CHECK`s

Two `BEFORE UPDATE` triggers were added when `authenticated` first gained write privileges on
`accounts` and `categories`
(`supabase/migrations/20260827120001_account_category_writes.sql`). Both express rules a `CHECK`
cannot: each compares `NEW` against `OLD`, and two of the three consult other tables.

- **`accounts_guard_update()`** — (1) `type` is immutable once the account exists; (2)
  `opening_balance_cents` may change only while the account has **zero** transactions, since it is
  the only stored balance figure and editing it retroactively restates every balance that account
  has ever reported (§11), including ones already written into `net_worth_snapshots`; (3) the
  `is_archived` `false → true` transition requires a **derived** balance of exactly zero
  (`opening_balance_cents + SUM(that account's transactions)`), because an archived account is
  excluded from net worth and from the asset/liability totals. Unarchiving is unconditional — it
  can only restore a figure to the totals, never hide one.
- **`guard_category_kind_change()`** — `kind` may change only while the category is referenced by
  no row in `transactions.category_id`, `budgets.category_id`, or `bills.category_id`. `kind` is
  what separates income from spending in every rollup, so changing it on a category with history
  silently reclassifies settled figures. Rename and archive stay available to referenced
  categories: the rule is scoped to the one column.

Both are `SECURITY INVOKER` with `search_path = ''`, have `EXECUTE` revoked from `PUBLIC`/`anon`/
`authenticated`, and fire on `UPDATE` only — so neither affects the whole-user teardown cascade
(§5). Tests: `supabase/tests/database/120-account-guard.sql`, `130-category-guard.sql`.

### `assert_transaction_refs()` (Phase 7 CP3) — `BEFORE INSERT OR UPDATE` on `transactions`

Added when `authenticated` gained `INSERT`/`UPDATE`/`DELETE` on `transactions`
(`supabase/migrations/20260828120002_transaction_writes.sql`). It carries the four cross-row rules
no `GRANT`, `CHECK`, or policy can express. It applies to **every** row, movement legs included:
CP4 will insert transfer and card-payment legs through this same table, and a leg dated tomorrow
or landing in an archived account corrupts exactly the same figures as an ordinary row doing it.

1. **`date` may not be later than the owner's current calendar day**, computed as
   `(now() AT TIME ZONE <the owner's profiles.timezone>)::date` — the same source
   `lib/data/clock.ts` reads for `getToday()`, so the form's message and the database's refusal
   can never disagree. **There is no server-UTC shortcut**, and that is the point: for an owner at
   UTC+13 a UTC ceiling would reject a transaction they are entering right now on the date their
   own calendar shows, and for an owner at UTC−8 it would accept one dated tomorrow for several
   hours each night. `135-posted-ledger.sql` contains cases built specifically to fail if this is
   ever rewritten against a UTC date. This table is the ledger of what *has happened*; a
   future-dated row is an intention, and this schema already has a place for those (§13).
2. **The account may not be archived.** Archiving requires a derived balance of exactly zero
   (`accounts_guard_update()`, above) and an archived account is excluded from net worth and from
   the asset/liability totals — so posting into one would create money that exists in the ledger
   and in no summary. "Unarchive it first" is the rule.
3. **A category, when present, must be active and kind-compatible** — `income` requires an
   `income` category; `expense` and `refund` require an `expense` one (a refund reduces the spend
   of the category it refunds; it is not income). Uncategorized ordinary rows stay legal.
4. **An adjustment carries no category**, and neither does a movement leg — both also `CHECK`s,
   so the same SQLSTATE arrives whichever layer fires first.

Cross-*owner* references are deliberately **not** this trigger's business: the composite FKs
(§6) already make a foreign account or category structurally impossible, so each lookup is scoped
to `(id, user_id)` and raises nothing when it finds no row, letting the deferred FK produce its
own `23503`. Taking those cases over would change the error code of situations
`040-ownership.sql` already pins, without refusing anything they do not already refuse. A profile
this statement cannot see is treated the same way, and the argument that this is safe is spelled
out in full in the migration: under RLS the only invisible profile belongs to a row the
`INSERT`/`UPDATE` policy is already refusing, and `transactions.user_id → profiles.id` is
`NOT DEFERRABLE` regardless.

`SECURITY INVOKER` with `search_path = ''`, `EXECUTE` revoked from `PUBLIC`/`anon`/
`authenticated`, and `INSERT`/`UPDATE` only — never `DELETE` — so the whole-user teardown cascade
(§5) is unaffected. Tests: `supabase/tests/database/135-posted-ledger.sql`.

### `reconcile_account()` (Phase 7 CP5) — the only path that writes an `adjustment`

`public.reconcile_account(p_account_id, p_as_of, p_desired_balance_cents)`
(`20260829120001_reconciliation.sql`) takes a *desired internal signed balance*, derives the
account's current balance in SQL as `opening_balance_cents + SUM(transactions.amount_cents)` —
the same expression `account_balances` computes (§11), including movement legs and earlier
adjustments — and inserts one row for the difference:

```
kind        = 'adjustment'
amount_cents= desired - derived        (either sign; see the CHECK below)
date        = p_as_of
merchant    = 'Balance adjustment'     (a fixed literal, never caller text)
category_id = null                     (transactions_adjustment_no_category_ck)
movement_id = null                     (transactions_movement_biconditional_ck)
```

A zero difference writes **no row** and reports success, which is also what makes reconciliation
idempotent with no idempotency key: a resubmission computes its delta against a balance the first
submission already corrected. **Reconciliation never rewrites history** — no existing transaction
is touched, and `opening_balance_cents` is deliberately *not* the mechanism (editing it would
restate every balance the account ever reported, which is why `accounts_guard_update()` freezes
it once the account has any transaction at all).

The sign is unconstrained because `transactions_sign_by_kind_ck`'s `adjustment` branch is
unconstrained — a correction's direction is whatever the correction requires. The row moves the
account's derived balance and net worth while appearing in **no** economic total:
`countsAsSpending`/`countsAsIncome` (`lib/finance/transactions.ts`) are allowlists, so an
adjustment is excluded *by kind*, not by its sign and not by lacking a category.

`SECURITY INVOKER` with `search_path = ''`, the owner from `auth.uid()` and never a parameter,
`EXECUTE` revoked from `PUBLIC`/`anon` and granted to `authenticated`. It deliberately re-checks
nothing that already has an owner: the posted-date ceiling and the archived-account refusal are
`assert_transaction_refs()`'s, above. Tests:
`supabase/tests/database/150-reconciliation.sql`.

An adjustment is **never editable** (`transactions_update_own_ordinary` carries
`kind <> 'adjustment'` in both `USING` and `WITH CHECK`) and **always deletable by its owner**
(`transactions_delete_own_non_movement` carries only `movement_id IS NULL`). That asymmetry is
the correction path: remove the adjustment and reconcile again.

### Deliberately absent constraints

- **No global `amount_cents <> 0` on `transactions`.** Would reject the legal zero-amount fixture
  row (§17).
- **No "every non-movement row must have a category" rule.** Same fixture row: a legally
  uncategorized ordinary expense exists today.

Both omissions are intentional and should not be "fixed" by a future migration without first
re-checking the fixture that motivates them.

### Cross-row invariants — see §7 for the movement rule in full

A movement's two legs arguably should share a `date`; the fixtures always do. **Recommend
deferring this as a constraint** — a real cross-institution transfer can legitimately settle a
day apart. Recorded here as an open question, not a silent omission.

---

## 7. The movement invariant in detail

Not expressible in a `CHECK` — it spans rows. Documented as required **behavior** here; no
trigger SQL is written in this phase.

**Structure:** a parent `movements` row plus exactly two `transactions` legs referencing it via
`movement_id`. The parent table is what gives deletion a correct unit and gives the trigger a
stable anchor to validate against — a bare shared identifier with no parent row (which is how the
current fixtures represent it) has neither.

**Single-row guarantees (§6)** — expressible as ordinary `CHECK` constraints on `transactions`
alone, since every referenced column is on the same row: movement-kind transactions require a
non-null `movement_id` (and vice versa); movement legs' `amount_cents` is nonzero; movement legs
carry no category. **"Each leg's `kind` matches the parent movement's `kind`" is deliberately
*not* listed here** — it compares a `transactions` row against its parent `movements` row, which
spans two tables and is therefore a cross-row guarantee, asserted by the deferred trigger below
(assert 3), not a single-row `CHECK`.

**Cross-row guarantee — a `DEFERRABLE` constraint trigger:**

- **Fires:** `AFTER INSERT OR UPDATE OR DELETE` on `transactions`, and `AFTER INSERT OR UPDATE`
  on `movements` — the latter is what makes an orphan movement with zero legs fail.
  `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`.
- **Why deferred:** the two legs of one movement are inserted as two separate statements inside
  one transaction. A non-deferred (`IMMEDIATE`) trigger would fail validating the first leg,
  before the second exists. Validation must run at `COMMIT`, once both statements have landed.
- **Asserts, for every movement touched during the transaction:**
  1. exactly two legs reference it;
  2. `SUM(amount_cents) = 0` across those legs;
  3. each leg's `kind` equals the parent movement's `kind`;
  4. the two legs reference **different** `account_id`s;
  5. all rows (movement + both legs) share the same `user_id`.
- Item 5 is already structurally guaranteed by the composite foreign key (§3) — the trigger
  re-asserts it as belt-and-braces, and it is the one guarantee that survives even if the trigger
  were somehow disabled.

**Cascade case — required, not incidental:**

| Operation | Required outcome | Why |
|---|---|---|
| Delete the parent `movement` (cascades both legs via `ON DELETE CASCADE`) | **Must succeed.** | This is the intended, only supported deletion path. |
| Delete **one** leg directly, parent still exists | **Must fail.** | Leg count = 1 ≠ 2, parent present. |
| Delete **both** legs directly, parent still exists | **Must fail.** | Leg count = 0 ≠ 2, parent present. |
| Update either leg so the pair no longer sums to zero | **Must fail.** | Sum ≠ 0. |

**The trigger must key its validation on parent existence**: when checking a `movement_id` at
`COMMIT`, it must first confirm the parent movement still exists in `movements`. If the cascading
delete already removed the parent, the trigger **skips** that movement — the cascade is
intentional, and a check that doesn't skip it would falsely reject a legitimate delete. This is
precisely what distinguishes the legitimate cascade case from the two illegitimate direct-
deletion cases above: in both of those, the parent is still present, so the leg-count check still
fires and still fails.

**Phase 7 CP4 — what this invariant turned out to imply for writes.** The rules above were
written as validation. Taken together with `transactions_movement_fk` being **`ON DELETE CASCADE`
but not `DEFERRABLE`**, they also decide the *only shape a movement write can take*, and that
consequence was not obvious until CP4 tried to build one:

- A parent inserted alone cannot commit (zero legs).
- A leg naming a movement that does not exist yet fails immediately, at the statement (23503).
- A parent with one leg cannot commit.

PostgREST issues one statement per request, each in its own transaction, so **no sequence of
PostgREST calls can produce a movement.** Creating and editing one therefore had to become
`SECURITY INVOKER` functions — `public.create_movement` and `public.replace_movement`
([rls-policies.md §3](rls-policies.md)) — and that is not a layering preference, it is the only
reachable path. Editing is delete-and-recreate under the movement's *original* id rather than an
`UPDATE`, because an edit can change the amount, the date, the kind and either account, and every
one of those has to land on both legs at once: two sequential updates would pass through a state
where the pair does not sum to zero, and there is no statement that could rewrite one leg anyway
(the ordinary `UPDATE` policy makes legs invisible). Since the delete and the re-creation are one
transaction, a refused replacement leg aborts everything and leaves the original pair byte-for-
byte intact.

Deleting stays exactly the cascade case above: one statement on the parent, which is the sole
supported deletion path and now also the only one `authenticated` can express.

Document the intended failure message and require that it never include transaction amounts —
see the error taxonomy in [DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md) (Phase 3, decision A).

---

## 8. Indexes

| Table | Index | Serves |
|---|---|---|
| `transactions` | `(user_id, date DESC, created_at DESC, id ASC)` | **Primary.** Matches the Phase 3 ordering contract `date DESC, created_at DESC, id ASC` (§17) in full — the complete ordering sequence after `user_id`; the bounded `from`/`to` window (finalized in Phase 3) is a range scan on this. |
| `transactions` | `(user_id, account_id, date DESC)` | `TransactionFilters.accountId` |
| `transactions` | `(user_id, category_id, date DESC)` | `spendingByCategory`, budget rollups |
| `transactions` | `(movement_id)` WHERE `movement_id IS NOT NULL` | Partial index — the movement trigger's leg lookup |
| `transactions` | trigram index on `merchant` | **Not a Phase 6 correctness blocker.** `TransactionFilters.search` runs as `ILIKE '%…%'` (`lib/data/transactions.ts`) with no trigram index, verified in Phase 6 to still return correct, bounded results against the single-owner dataset. Recorded as a **future performance optimization** — add `pg_trgm` + a GIN index only if `merchant` search latency actually becomes a problem at realistic per-owner row counts. No migration for it shipped in Phase 6. |
| `accounts` | `(user_id)`; `UNIQUE (id, user_id)` | Listing + composite FK target |
| `categories` | `(user_id)`; `UNIQUE (id, user_id)`; **a unique expression index** on `(user_id, lower(name))` — not an ordinary `UNIQUE` constraint, since it indexes the result of `lower(name)` rather than a plain column list | Per-user uniqueness without case-duplicate categories |
| `budgets` | `UNIQUE (user_id, category_id, period)` | One budget per category per month |
| `bills` | `(user_id)`; `UNIQUE (id, user_id)` | |
| `bill_occurrences` | `(user_id, due_date)`; `UNIQUE (bill_id, due_date)` | Bills page groups by due date; unique makes generation idempotent |
| `goals` | `(user_id)`; `UNIQUE (id, user_id)` | |
| `goal_contributions` | `(user_id, goal_id, occurred_on DESC)` | Supports the derived `saved_cents` rollup |
| `net_worth_snapshots` | `PRIMARY KEY (user_id, month)` (§14) | Serves both uniqueness and the one-snapshot-per-user-per-month lookup — no separate surrogate key or index needed |
| `movements` | `(user_id)`; `UNIQUE (id, user_id)` | |

---

## 9. Money and BIGINT rules

The invariant, precisely — not "all `*_cents` columns are `NOT NULL`", since two legitimately
aren't:

1. **Every monetary cents column uses PostgreSQL `BIGINT`.** No `numeric`, no floating point,
   anywhere in the schema.
2. **Required monetary facts are `NOT NULL`.**
3. **Nullable monetary columns are nullable only where null carries an explicit, documented
   domain meaning** — never as an ambiguous substitute for zero.

The nullable exception:

| Column | Null means |
|---|---|
| `accounts.credit_limit_cents` | Not applicable — the account type has no credit limit |

Every other cents column in the schema is `NOT NULL` — **including
`bill_occurrences.amount_cents`**, which was reconsidered from an earlier "inherit from the
parent bill" nullable design. `bills` and `bill_occurrences` represent two different facts at
two different levels, not one value with a fallback: `bills.amount_cents` is the recurring
template's *current* default; `bill_occurrences.amount_cents` is copied from it **at generation
time** and then stands on its own as a concrete historical fact. If it were nullable and
resolved dynamically against the parent at query time, editing a recurring bill's amount later
would retroactively change the effective amount of every old occurrence, including already-paid
history — exactly the kind of silent rewrite this schema's delete/archive philosophy (§5) exists
to prevent. See §13 for the full model and what a later bill edit is allowed to do to *future*
occurrences.

`interest_rate_bps` (basis points, not cents) is `INTEGER`, nullable with the same "not
applicable" meaning as `credit_limit_cents`.

**The DB→TS mapper contract is unchanged from today's `toCents()`:** every **non-null** `BIGINT`
value crossing the boundary passes through `toCents()` (`lib/types/index.ts`), which throws on a
non-safe-integer value. **Reject invalid or unsafe data — never silently coerce it.** A silently
truncated balance is a worse failure mode than a visible error. Null values are mapped to
`undefined` (or the documented inherited value) *before* the safe-integer check runs — never
coerced to `0`.

**Verified empirically in Phase 4, not merely assumed:** local PostgREST serializes a `BIGINT`
column — including the view-computed `account_balances.balance_cents` and
`goal_balances.saved_cents` — as an **unquoted JSON number**. PostgreSQL/PostgREST itself
preserved `9007199254740993` exactly in the payload; it was JavaScript's `JSON.parse` that rounded
it, because that value exceeds `Number.MAX_SAFE_INTEGER`. The existing `Number.isSafeInteger`/
`toCents()` boundary already rejects the resulting unsafe value rather than silently coercing it —
no mapper change was needed. This was one empirical boundary test, not a proof for every
out-of-range value or for every possible PostgREST/supabase-js configuration; the mapper contract
below (reject, never coerce) is what makes that gap safe regardless.

Floating point stays confined to `lib/format/**` and to `percentage()`'s divide-first display
output (`lib/finance/money.ts`) — a display value, never re-stored.

---

## 10. Date and timezone rules

- **`profiles.timezone`** is `TEXT NOT NULL DEFAULT 'UTC'`, an IANA timezone identifier.
- **Validation mechanism — decided:** a `BEFORE INSERT OR UPDATE` trigger function on `profiles`
  that checks the supplied value against Postgres's `pg_timezone_names` catalog and raises if it
  doesn't match.
  - **Not a regex** — a regex can confirm a string *looks like* `Area/City` but cannot confirm
    the zone actually exists.
  - **Not a `CHECK` constraint** — `pg_timezone_names` is a catalog lookup, not an immutable
    scalar expression. A `CHECK` calling it would misrepresent a mutable-catalog read as an
    immutable per-row invariant, which is unsound across dump/restore and catalog version
    changes.
- **Production `getToday()` derives the calendar date from the authenticated user's
  `profiles.timezone`**, never the server's clock — **implemented in Phase 6 Checkpoint 4**
  (`lib/data/clock.ts`, `calendarDateInTimeZone` in `lib/data/calendar.ts`). There is deliberately
  no development-only `MOCK_TODAY` branch in production: seeded fixture data ages out of "this
  month" as real time advances, which is the correct, visible consequence, and every page already
  has an empty state for it. `getToday()` throws `data_integrity` rather than defaulting to UTC if
  the verified owner has no profile row or an unusable zone — a silently wrong "today" would
  silently corrupt "this month" totals, budget periods, and overdue-bill grouping.
  `calendarDateInTimeZone` constructs `Intl.DateTimeFormat` with explicit `{ timeZone: tz, year:
  'numeric', month: '2-digit', day: '2-digit' }`, calls `.formatToParts()` rather than `.format()`,
  and explicitly assembles the `year`/`month`/`day` parts into a `'YYYY-MM-DD'` string —
  `Intl.DateTimeFormat`'s locale-formatted string output (even with locale `'en-CA'`) is not
  guaranteed across environments to be exactly machine-parseable `YYYY-MM-DD`; `formatToParts()`
  gives structured `{ type, value }` parts to assemble explicitly instead of relying on that string
  shape.
- **Financial dates stay `DATE`**: `transactions.date`, `bill_occurrences.due_date`,
  `goal_contributions.occurred_on`, `goals.target_date`, `bills.anchor_date` — calendar values,
  never instants. Audit columns (`created_at`, `updated_at`) are `TIMESTAMPTZ`. Conflating the
  two is exactly the class of bug `lib/finance/dates.ts` already exists to prevent
  (`parseCalendarDate` avoids `new Date('YYYY-MM-DD')`'s UTC-midnight parsing; `daysBetween` uses
  `Date.UTC` to stay DST-safe).
- `budgets.period` and `net_worth_snapshots.month` stay `TEXT` `'YYYY-MM'` — matches `MonthKey`
  and sorts correctly as plain text.
- `lib/finance/**` keeps taking `today` as an explicit parameter; it never reads a clock. The
  existing ESLint fence blocking `Date.now()`/`new Date()` in that directory is unaffected.

---

## 11. Derived account balances

```
accounts.opening_balance_cents BIGINT NOT NULL
```

A view, `account_balances` — implemented in `20260822150005_views.sql`; the shape below is the
original design sketch, kept for narrative purposes (the shipped SQL additionally scopes the join
on `user_id` and casts the sum back to `::bigint`, since `SUM(bigint)` returns `numeric`):

```sql
-- design sketch — see supabase/migrations/20260822150005_views.sql for the actual SQL
SELECT a.id, a.user_id,
       a.opening_balance_cents
         + COALESCE(SUM(t.amount_cents), 0) AS balance_cents
FROM accounts a
LEFT JOIN transactions t ON t.account_id = a.id
GROUP BY a.id, a.user_id;
```

`LEFT JOIN` is required: an account with zero transactions must still return its opening balance,
and archived accounts must still appear, since `app/(app)/accounts/page.tsx` renders them in an
"Archived" group.

**Must be declared `WITH (security_invoker = on)`** — see
[rls-policies.md](rls-policies.md#security_invoker-views) for why a default-owner view would
silently bypass RLS.

**DTO is unchanged.** `Account.balanceCents` still arrives populated on every `Account` returned
by the DAL, so `lib/finance/accounts.ts`, every consuming component, and all 66 existing tests
are untouched by this design.

**Seeding arithmetic — the important consequence.** The mock fixtures store each account's
balance as an independent scalar (`lib/mock/accounts.ts`) that is **not** the sum of that
account's fixture transactions (`lib/mock/transactions.ts`, Mar–Aug 2026). To reproduce the
existing fixture balances exactly under the derived model, `supabase/seed.sql` (generated by
`scripts/generate-seed.ts`, Phase 4) back-computes, per account:

```
opening_balance_cents = fixture_balance_cents − SUM(that account's fixture transaction amounts)
```

This is what keeps the net-worth coherence assertion in `lib/mock/index.test.ts` — "the latest
net-worth snapshot matches current account totals" — passing once the DB-backed values replace
the fixture-backed ones, and is verified directly by the seed-parity pgTAP suite
(`supabase/tests/database/010-seed-parity.sql`).

A consequence worth noting: under this model, `netWorth === totalAssets − totalLiabilities`
becomes an **emergent property of the ledger**, rather than a stored coincidence that could drift
from it.

---

## 12. Goal contribution model

```
goals              (id, user_id, name, target_cents, target_date NULL, archived_at NULL, ...)
goal_contributions (id, user_id, goal_id, amount_cents, occurred_on, note NULL, created_at)
```

- **Append-only for all normal application use: SELECT and INSERT only.** No UPDATE, no DELETE
  through the application API (§5). This is what makes `saved_cents` genuinely auditable — a
  mutable ledger is not an audit trail.
- **Corrections are compensating rows**, positive or negative — `amount_cents` is signed, with no
  `<> 0` constraint (consistent with the precedent set for ordinary transactions in §6).
- Administrative/manual database correction remains *possible* outside the normal application
  path if absolutely necessary, but is explicitly **not part of the application API** and must
  not be exposed through any Server Action.
- **Archiving the parent goal retains every contribution** — deleting a goal must never silently
  destroy its financial history.
- `saved_cents` is derived: `COALESCE(SUM(amount_cents), 0)` per goal, via a `security_invoker`
  rollup view mirroring §11's pattern.
- Composite FK `(goal_id, user_id) → goals(id, user_id)` provides the required
  goal-ownership match.
- **Deliberately not linked to `transactions`** — a goal contribution is an allocation/adjustment
  record, not necessarily an account movement. A future optional `transaction_id` column is
  possible but explicitly out of scope for this phase, so its absence should read as a decision,
  not an oversight.

**DTO is unchanged.** `Goal.savedCents` still arrives populated, so `lib/finance/goals.ts` and
`GoalCard` are untouched — the same derive-into-the-same-shape pattern as §11.

---

## 13. Recurring bill / occurrence model

```
bills            (id, user_id, name, amount_cents, frequency, category_id NULL,
                  account_id NULL, anchor_date, is_archived, created_at)
bill_occurrences (id, user_id, bill_id, due_date, status, amount_cents,
                  transaction_id NULL, paid_on NULL, created_at)
```

`bills` describes the recurring obligation; `bill_occurrences` is one concrete due instance.

### Occurrence amounts — two facts at two levels, not a competing source of truth

`bills.amount_cents` is the recurring template's **current/default** amount.
`bill_occurrences.amount_cents` is **`BIGINT NOT NULL`, copied from `bills.amount_cents` at the
moment the occurrence is generated**, and from then on stands independently as the amount that
concrete historical instance actually carries.

This is a deliberate correction from an earlier "nullable, inherit dynamically from the parent"
design. A dynamic inherit means every occurrence's *effective* amount is recomputed from
whatever the parent bill currently says — so editing a recurring bill's amount later would
retroactively change the amount of every past occurrence, including already-`paid` ones. That
would silently rewrite payment history exactly the way §5's governing rule forbids. Copying the
value at generation time means `bills.amount_cents` and `bill_occurrences.amount_cents` are **two
different facts about two different things** — "what this recurring obligation currently costs"
versus "what this specific instance was actually due for" — not one value with a fallback, so
there is no ambiguity about which is authoritative for which question.

`UNIQUE (bill_id, due_date)` makes occurrence generation idempotent.

### `transaction_id` — structural ownership, not a loose reference

```
transactions:      UNIQUE (id, user_id)
bill_occurrences:  FOREIGN KEY (transaction_id, user_id) REFERENCES transactions(id, user_id)
                     ON DELETE RESTRICT
```

Composite FK following the same pattern as every other cross-table reference in this schema
(§3) — it requires the linked transaction to belong to the same user as the occurrence, not just
any transaction row. `ON DELETE RESTRICT` (or equivalent `NO ACTION`), **never `SET NULL`**: a
transaction linked as an occurrence's payment history must not silently disappear from that
occurrence merely because the transaction row is deleted (§5). The column stays **nullable** —
an occurrence can be marked `paid` from a manually recorded payment with no linked transaction at
all; the FK's nullability and the `NOT NULL` requirement on `amount_cents` are independent
decisions serving different purposes.

### Status/payment-field consistency

Single-row `CHECK`s, stated in full in §6, restated here for context: `scheduled` and `skipped`
both require `paid_on IS NULL AND transaction_id IS NULL`; `paid` requires `paid_on IS NOT NULL`
but leaves `transaction_id` free to be null or non-null, since a manually recorded payment has no
transaction to link.

### Deletion-guard trigger — required behavior, no SQL yet

The `RESTRICT`/status story above governs `transaction_id`'s own deletion; a **separate** trigger
governs deleting the `bill_occurrences` row itself, because eligibility depends on `status` — not
expressible as a plain FK `RESTRICT`, which only reacts to whether a row is *referenced*, not to
an arbitrary column's value:

| Operation | Required outcome |
|---|---|
| `DELETE` a `scheduled` occurrence | Allowed |
| `DELETE` a `paid` occurrence | Rejected |
| `DELETE` a `skipped` occurrence | Rejected |

`authenticated` holds no DELETE grant on this table under any circumstance regardless
(`rls-policies.md`), so this trigger is defense-in-depth against a privileged or direct-SQL
deletion path, not the application's primary guard. Implemented in Phase 4 as
`guard_bill_occurrence_delete()`.

**Phase 7 CP7 put a second layer in front of it.** The schedule rebuild needs to remove the
scheduled rows it replaces, so `finance_snapshot_writer` gained a `DELETE` grant — behind a
policy reading `status = 'scheduled' AND user_id = private.request_owner_id()`. A paid or skipped
occurrence is therefore invisible to that `DELETE` at the *policy* layer, before the trigger is
consulted at all, and a session carrying no JWT claim can delete nothing whatsoever. The trigger
still fires and still refuses, for every role; `180-bill-writes.sql` proves both layers
independently.

### Status transitions — Phase 7 CP7

`guard_bill_occurrence_transition()` (`BEFORE UPDATE`) is the state machine. Supported, and
nothing else:

| From | To | Meaning |
|---|---|---|
| `scheduled` | `paid` | The obligation was met |
| `scheduled` | `skipped` | It did not apply this cycle |
| `paid` | `scheduled` | Correction — unmark; clears `paid_on` and `transaction_id` |
| `skipped` | `scheduled` | Correction — unskip |

A no-op status (`old.status = new.status`) is allowed unconditionally, which is what makes a
resubmitted mark-paid idempotent rather than an error. A direct `paid ↔ skipped` conversion is
**refused**: the two are different claims about what happened, and converting one to the other in
a single statement would clear or set payment fields as a side effect of a status change nobody
asked for. The correction goes back through `scheduled`, where it is visible as the two steps it
is.

The trigger also enforces `paid_on <= (now() AT TIME ZONE profiles.timezone)::date` — the owner's
own calendar day, the same expression `assert_transaction_refs()`, `assert_goal_contribution_refs()`
and `getToday()` use, never `current_date` and never server UTC. `due_date` gets no such ceiling
and never will: a bill is an obligation, and every useful one is in the future.

Finally it restates, at row level and for **every** role, that `id`, `user_id`, `bill_id`,
`due_date`, `amount_cents` and `created_at` may not move. The column-scoped grant already makes
them unreachable for `authenticated`; this is what makes it true of the scheduler as well, whose
whole contract is that it may add a scheduled occurrence or remove one, and may never rewrite
one.

### Phase 7 CP7 — what a bill edit does, and what it may never touch

Implemented in `supabase/migrations/20260831120001_bill_writes.sql`. The rule this section
recorded in advance held exactly as written, and is now enforced in SQL:

- If a recurring bill's **amount, frequency, or anchor date** changes, `public.replace_bill`
  rebuilds its future schedule inside the same transaction as the `UPDATE` — so a refused
  regeneration rolls the edit back with it, and the old bill *and* its old schedule survive byte
  for byte. A change to `name`, `category_id` or `account_id` rebuilds nothing: those decide none
  of the schedule, and a needless rewrite would give every future row a new id and `created_at`.
- **`paid` and `skipped` occurrences are never rewritten by anything.** The rebuild's `DELETE`
  names `status = 'scheduled'`, the writer's own `DELETE` policy names it again, Phase 4's
  `guard_bill_occurrence_delete()` refuses one for any role, and
  `guard_bill_occurrence_transition()` refuses to move `amount_cents` or `due_date` on any row.
- **Already-overdue `scheduled` occurrences are preserved too.** The rebuild's cutoff is the
  owner's own calendar day (`(now() AT TIME ZONE profiles.timezone)::date`), not server UTC: an
  obligation that already fell due is a fact about the past even though nobody has acted on it
  yet.
- **No rebuild manufactures a past-dated obligation.** Generation starts at the bill's anchor
  **only when the bill has no occurrence at all** — true exactly once, at creation, which is what
  lets someone track a bill whose first due date has already passed. Every later call starts at
  the owner's today.

### Phase 7 CP7 — the rolling horizon

`private.generate_bill_occurrences` (Phase 4) takes a horizon as a parameter and was never
scheduled. CP7 fixes one, in `public.maintain_bill_schedule` and nowhere else: **one year from
the owner's own calendar day, widened to the bill's `anchor_date` when that anchor lies further
out.** It is a constant in the function body — no caller can supply, widen or narrow it.

One year is the conservative choice for the three things the schedule has to support: a `yearly`
bill always has a next occurrence (the frequency that would break first under a shorter window);
`getBills()` and the dashboard projection always find one for every active bill; and a `weekly`
bill needs its ~52 rows once rather than on every page load. The anchor widening is not a
rounding detail — a bill whose first tracked due date is deliberately more than a year out (an
annual premium set up early, a lease starting next autumn) would otherwise generate *nothing*, be
omitted by `getBills()`, and read exactly like the create having failed.

**Generation is mutation-time maintenance, never a render-time side effect.** No read path calls
the scheduler. It runs inside `create_bill`/`replace_bill`/`set_bill_archived`, and — best-effort,
after the write has already committed — after an occurrence status change, which is the moment an
owner naturally revisits a bill as time passes. An archived bill generates nothing and loses
nothing.

### Recurrence semantics — deterministic, documented now, not implemented

**Every rule derives the next due date from the ORIGINAL `bills.anchor_date`, never from a
previously-clamped occurrence.** Deriving from a clamped value causes permanent date drift: a
`Jan 31` bill naively clamped to `Feb 28` and then advanced a month at a time from *that* value
would yield `Mar 28`, `Apr 28`, … and never return to the 31st.

| Frequency | Rule |
|---|---|
| `weekly` | `anchor_date` + 7-day intervals |
| `biweekly` | `anchor_date` + 14-day intervals |
| `monthly` | Preserve the **original anchor day-of-month**. If that day doesn't exist in the target month, clamp to that month's final calendar day — computed independently per month, from the anchor, not from the prior occurrence. |
| `yearly` | Preserve the original month/day. A `Feb 29` anchor clamps to `Feb 28` in a non-leap year and **returns to `Feb 29`** the next time the year is a leap year. |

Worked example, `monthly` with `anchor_date = 2026-01-31`:

```
Jan 31 → Feb 28 (2026, non-leap) → Mar 31 → Apr 30 → May 31
```

Each value is `anchor day-of-month = 31` clamped independently against that month's length — not
computed from the previous row.

Occurrences are generated forward through a rolling horizon, idempotent via
`UNIQUE (bill_id, due_date)` so re-running the generator never duplicates. The generator arrived
with the snapshot writer in Phase 4 (`private.next_bill_occurrence_date`,
`private.generate_bill_occurrences`); Phase 7 CP7 adds
`private.generate_bill_occurrences_for_bill`, which reuses that same pure date arithmetic and
adds only a per-bill window around it. **The month-end and leap-year rules have exactly one
implementation, and CP7 did not copy it.**

CP7's generator differs from Phase 4's in two ways, and neither is stylistic: it walks **one
bill** (an edit rebuilds one bill's future, not every bill's), and it walks from **the anchor**
rather than from `max(due_date)`. The second matters after an anchor or frequency change:
`next_bill_occurrence_date(anchor, freq, after)` advances in whole periods from the *anchor's* own
month, so handing it a due date from the old series can skip the first occurrence of the new one
outright. Walking the new series from its own anchor is the only formulation that cannot drift.

### DTO projection — how the existing `Bill` shape survived Phase 6 unchanged

Today, `Bill` ([lib/types/index.ts](../lib/types/index.ts)) is one object carrying `dueDate`
directly, and `billStatus(bill, today)` (`lib/finance/bills.ts`) reads that field. Bills is **the
only** locked decision that changes storage cardinality — a naive one-to-one port of the new
model would ripple through `lib/types`, `lib/finance/bills.ts` and its tests,
`components/bills/**`, `components/dashboard/upcoming-bills.tsx`, and both consuming pages.

**Resolution:** the schema satisfies the "no mutable pointer, full history retained" requirement
completely at the storage layer. The **Phase 6 DAL** (`lib/data/bills.ts`) projects the next
unpaid occurrence into the existing `Bill` DTO shape — `dueDate` is "the earliest `scheduled`
occurrence's `due_date` for this bill," computed at query time via two queries (active `bills`,
then their `scheduled` `bill_occurrences`) reduced to one occurrence per bill in TypeScript, since
PostgREST's embedded-resource `order`/`limit` applies to the flattened join rather than per parent
row. **Decided in Phase 4, shipped in Phase 6: this projection is a DAL query, not a third
view** — `20260822150005_views.sql` creates exactly the two views in §1 (`account_balances`,
`goal_balances`).

**Phase 7 CP7 is the point at which occurrence history did enter the UI, and `getBills()`'s
contract is unchanged by it.** It still returns *active* bills projected onto their earliest
`scheduled` occurrence, and `/dashboard` still depends on exactly that. CP7 adds a second, wider
read alongside it — `getBillsForManagement()` (`lib/data/bills.ts`), returning every owned bill
(archived included) with its recurrence terms, its archive state, its full occurrence history and
the derived `nextDueDate`. Two queries whatever the bill count, never N+1, for the same reason
`getBills()` uses two: PostgREST's embedded-resource `order`/`limit` applies to the flattened
join rather than per parent row.

The two shapes are deliberately not one. `Bill.dueDate` is required, and a bill whose occurrences
are all paid or skipped has no honest value for it — which is precisely the case a management view
must still be able to show and fix, so `BillManagement.nextDueDate` is optional. The
`BillOccurrence` DTO (`lib/types/index.ts`) carries each occurrence's **own** `amountCents`, never
the parent's current amount; a display layer that fell back to the bill's headline figure would
silently undo this section's whole guarantee in the one place a person goes to check it.

---

## 14. Net-worth snapshots

```
net_worth_snapshots (user_id, month, assets_cents, liabilities_cents,
                     net_worth_cents, created_at)
PRIMARY KEY (user_id, month)
CHECK  (month ~ '^\d{4}-(0[1-9]|1[0-2])$')
CHECK  (assets_cents >= 0 AND liabilities_cents >= 0)
CHECK  (net_worth_cents = assets_cents - liabilities_cents)
```

**Stored, not derived** — documented in `lib/mock/net-worth.ts` and preserved here for the same
reason: a derived monthly series would need a complete, gapless transaction ledger back to each
account's opening, and any gap would silently corrupt every subsequent point on the trend.
`liabilities_cents` is a positive magnitude, matching the `NetWorthSnapshot` convention in
`lib/types/index.ts` — now an enforced `CHECK` rather than a comment. Month boundaries resolve in
the user's `profiles.timezone` (§10).

### Why `PRIMARY KEY (user_id, month)` instead of a surrogate key + `UNIQUE`

An earlier draft of this design gave the table an implicit/surrogate primary key plus a separate
`UNIQUE (user_id, month)` constraint. That's two mechanisms doing one job. `(user_id, month)` is
already the table's natural identity — "the snapshot for this user, this month" is the only thing
a row *is*, there is no other identity a row could meaningfully have, and nothing else in the
schema needs to reference an individual snapshot row by a separate id (no other table has a
`snapshot_id` foreign key). Making the natural key the actual primary key removes the redundant
index a separate surrogate-key-plus-`UNIQUE` pair would otherwise require, and it makes
`UPSERT ... ON CONFLICT (user_id, month)` (used by both the `pg_cron` writer and the on-demand
fallback below) target the primary key directly.

### The writer must compute each snapshot **as of its target month**, not as of "now"

**Correction to an earlier draft:** the snapshot writer must **not** simply read today's
`account_balances` view (§11) and stamp it with whatever month happens to be current when the
job runs. `account_balances` answers "what is this account worth right now" — the snapshot needs
"what was this account worth **as of the end of month X**," which is a different question the
moment the writer runs anything other than exactly once, exactly at each month's boundary
(regeneration, backfill, and retry all run at some *other* time than the instant the month ended).

For a target snapshot month `M`, each account's balance **as of that month** is:

```
opening_balance_cents
  + SUM(transactions.amount_cents WHERE transactions.date <= last_calendar_day_of(M))
```

— the same `opening_balance_cents + SUM(ledger)` shape as the live `account_balances` view
(§11), but with the transaction sum bounded by the target month's last calendar day rather than
unbounded ("now"). This must hold for **every** invocation path: scheduled `pg_cron` generation,
a retried run, the documented on-demand fallback, and any intentional backfill/regeneration of a
past month — all of them compute the *same* as-of query for the *same* target month and must
produce the *same* result, which is exactly what makes the fallback and retries safe to rerun.

This is implemented as a dedicated function, `private.write_net_worth_snapshot(p_user_id, p_month)`
(`20260822150008_snapshot_writer.sql`), parameterized by `(user_id, month)` — never the plain
`account_balances` view, since that view has no month parameter to bound its `SUM` by.
`private.write_net_worth_snapshots_for_range(p_user_id, p_from_month, p_to_month)` backfills a
range by calling the single-month function once per month — never a divergent calculation.

### Classification — the exact existing convention, not a guess

Assets/liabilities classification and the signed-balance convention are **not reinvented here** —
they must match [lib/finance/accounts.ts](../lib/finance/accounts.ts) exactly, since that module
is what the fixture-coherence test in `lib/mock/index.test.ts` checks the snapshot against today,
and nothing in Phase 4 changes that module:

- **`accountKind(type)`**: `LIABILITY_TYPES = ["credit", "loan"]`; every other `account_type`
  (`checking`, `savings`, `cash`, `investment`) is `"asset"`.
- **Archived accounts are excluded** — `activeAccounts()` filters out `is_archived` before any
  totals are computed.
- **`totalAssets`**: the sum of active asset-type accounts' (as-of) balances — a positive figure,
  since asset balances are stored positive.
- **`totalLiabilities`**: the signed sum of active liability-type accounts' (as-of) balances,
  negated to a positive magnitude (`toCents(-signedSum || 0)`, guarding the `-0` case with no
  liabilities) — liability balances are stored negative, so this recovers a positive figure from
  them.
- **`netWorth`**: the sum of *every* active account's signed (as-of) balance — assets contribute
  positively, liabilities negatively, with no separate subtraction step.

The snapshot writer must apply this same classification to the as-of balances above, not to the
live `account_balances` view, when computing `assets_cents`/`liabilities_cents`/`net_worth_cents`
for a historical or backfilled month.

**Intended writer: `pg_cron`, running monthly.** **Decided in Phase 4 (Option B, approved at
Gate 3):** a dedicated `NOLOGIN`/`NOSUPERUSER`/`NOBYPASSRLS` role, `finance_snapshot_writer`, owns
the snapshot-writer functions as `SECURITY DEFINER` and receives narrowly-scoped object grants
plus matching role-targeted RLS policies — see
[rls-policies.md](rls-policies.md#9-security-definer-bypassrls-and-the-snapshot-writer) for the
hardening requirements this satisfies, and
[DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md#phase-4--supabase-provisioning--migrations--complete)
for the full verified writer-design facts. No `cron.schedule()` call exists yet — Phase 4 settles
and proves the privilege model only; actual scheduling remains future work. The writer uses the
as-of design above, never "simply reads current `account_balances` across every user."

**Documented fallback if `pg_cron` is unavailable on the target Supabase plan: idempotent
on-demand snapshot generation** — safe to call repeatedly, `UPSERT`ing on the
`(user_id, month)` primary key, using the same as-of query for whatever month is requested. The
primary key is what makes either writer, or any retry of either, safe under concurrent or
repeated invocation.

`authenticated` never writes this table directly under any circumstance — see
[rls-policies.md](rls-policies.md).

### Phase 7 CP5 — the current month, and only the current month

`pg_cron` is still not scheduled, and the fallback above is now real:
`public.refresh_current_net_worth_snapshot()` (`20260829120002_current_snapshot.sql`) is a
zero-parameter `SECURITY DEFINER` bridge, owned by `finance_snapshot_writer`, that
`authenticated` may `EXECUTE`. It derives the caller from the request's own JWT claim, reads
that owner's `profiles.timezone`, takes `to_char((now() at time zone <that zone>)::date,
'YYYY-MM')`, and calls the **unchanged** Phase 4 `private.write_net_worth_snapshot` with both.
Neither the owner nor the month is a parameter, so the bridge cannot become a general
snapshot-writing API; `private.write_net_worth_snapshots_for_range` keeps its Phase 4 posture
with no wrapper of any kind, and backfill remains an operator action. Full privilege rationale
in [rls-policies.md §3](rls-policies.md), *What Phase 7 CP5 added*.

### Phase 7 CP8A — `pg_cron` is finally scheduled, and it is the writer this section always intended

The "intended writer" from Phase 2/4 — an unattended, `pg_cron`-scheduled pass that iterates
over every owner rather than one request's own owner — is implemented in
`20260901120001_scheduled_maintenance.sql` as `private.refresh_all_current_net_worth_snapshots()`,
run daily. It is a *second*, separate function from CP5's `refresh_current_net_worth_snapshot()`
bridge, not a replacement for it: the two serve different callers (a live authenticated request
vs. an unattended daily pass with no JWT at all) and CP8A does not touch CP5's bridge, its grant,
or its RLS policy in any way. Both ultimately call the same unchanged Phase 4
`private.write_net_worth_snapshot(p_user_id, p_month)` — no snapshot arithmetic is duplicated a
third time.

pg_cron records the scheduling session's `current_user` as a job's `username` and executes the
job with that role's permissions; running a job *as a different* role requires the scheduling
role to be an actual database superuser (verified directly against the local image). These two
jobs are scheduled by the migration as `postgres` — itself `NOSUPERUSER`, so it never requests
that override — and so both execute as `postgres`. Because of that, the cron command is a single
call to a `SECURITY DEFINER` function owned by `finance_snapshot_writer`, so execution
immediately narrows from `postgres` down to that role's `NOLOGIN`/`NOBYPASSRLS` privileges. This
is the same mechanism CP5's and CP7's bridges use, applied in the opposite direction: those
narrow `authenticated`'s insufficient privilege *up* to what the writer needs; this one narrows
`postgres`'s `BYPASSRLS`-carrying privilege *down* to the writer's own RLS-bound, already-audited
reach.

Owner enumeration never widens CP5's narrow `profiles_select_writer` policy (`id =
private.request_owner_id()`, matching zero rows with no JWT claim set — the exact case a cron
job's own connection is). Instead, the daily function discovers candidate owners from `accounts`
(`finance_snapshot_writer` has held unconditional `SELECT` there since Phase 4), then, for each
owner in turn, calls `set_config('request.jwt.claim.sub', <that owner's id>, true)` before
touching `profiles` — the same GUC `private.request_owner_id()` already reads, impersonating one
owner's request context at a time rather than reading every profile in one unscoped query. See
the migration file for the full rationale and `090-privileges.sql` /
`190-scheduled-maintenance.sql` for the assertions that this policy is unchanged.

A companion function, `private.maintain_all_active_bill_schedules()`, runs on the same daily
schedule and closes CP7's own documented gap
([DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md#cp7--bills--bill-occurrences-), *Deliberate
limitation*: a bill nobody ever touches again eventually runs out of scheduled occurrences) the
same way — a non-destructive top-up, per bill, reusing `private.generate_bill_occurrences_for_bill`
unmodified, never a rebuild.

`lib/data/mutations/snapshots.ts` is the only module in the application that names it, and every
balance-affecting mutation calls it **after** its own write has committed, best-effort: the
refresh is a separate PostgREST request and therefore a separate transaction, so it can fail on
its own, and reporting an already-committed ledger write as failed because a derived aggregate
did not refresh would be a lie that invites a duplicate entry. Live derived balances are
authoritative; the snapshot series is a secondary trend, and the next balance-affecting write
brings it current because the writer recomputes the whole month from current state rather than
applying a delta.

**What CP5 deliberately does not do**, and the limitations that follow are accepted rather than
worked around: no `opened_on` column, no archived-at lifecycle reconstruction, no prior-month
rebuild control, and no repair of an old monthly snapshot after a backdated edit. A backdated
transaction moves the *current* month's snapshot (the as-of window ends at this month's last
day, so it includes every earlier row) but leaves the month it was dated into as it was.

**Two further limitations, inherited from Phase 4 and worth stating explicitly.**
`private.write_net_worth_snapshot` carries two sign guards and *raises* `data_exception`
(SQLSTATE 22000) **before writing anything** rather than storing either magnitude negative — the
`assets_cents >= 0 AND liabilities_cents >= 0` `CHECK` above is the same rule at the column level.
Both states are now reachable through ordinary supported writes:

- **`v_assets_cents < 0`** — the sum of every active non-`credit`/`loan` account is negative.
  Reachable by opening an account at a negative balance (`opening_balance_cents` is a plain signed
  `BIGINT` with no per-type sign constraint, and the validation layer accepts a signed figure for
  every type), by overdrawing one with an ordinary expense, by transferring out of one, or by
  reconciling one to a negative observed balance — which the reconcile form invites explicitly for
  asset accounts. The aggregate only goes negative when the owner's whole asset position does, so
  the realistic case is one overdrawn current account and no savings.
- **`v_liabilities_cents < 0`** — the aggregate `credit`/`loan` balance is *positive*: an overpaid
  card with no other debt offsetting it.

In both cases the ledger write still commits and the current-month snapshot goes **stale rather
than wrong** — the raise happens before the `INSERT … ON CONFLICT`, so an existing row is left
byte for byte — and the next balance-affecting write that returns the aggregate to a valid sign
recomputes the whole month. The underlying behavior is Phase 4's and CP5 does not alter it;
`supabase/tests/database/160-current-snapshot.sql` characterizes both guards at the database
layer and `tests/mutations/snapshots.test.ts` does the same at the action layer.

---

## 15. DTO mapping

| DTO (`lib/types/index.ts`) | Table(s) | Change to the DTO |
|---|---|---|
| `Cents` (branded) | every `*_cents` `BIGINT` column | none — `toCents()` remains the boundary guard |
| `CalendarDate` / `MonthKey` | `DATE` / `TEXT 'YYYY-MM'` | none |
| `Account` | `accounts` + `account_balances` view | **none** — `balanceCents` is derived (§11) |
| `Category` | `categories` (per-user) | none |
| `Transaction` / `TransactionKind` | `transactions` / `transaction_kind` enum | none; `movementId` is now FK-backed instead of a bare shared string |
| `Budget` | `budgets` | none |
| `Bill` / `BillFrequency` | `bills` + `bill_occurrences` / `bill_frequency` enum | **none in Phase 6**, under the §13 projection |
| `Goal` | `goals` + contribution rollup | **none** — `savedCents` is derived (§12) |
| `NetWorthSnapshot` | `net_worth_snapshots` | none — its convention is now a `CHECK` |
| *(new)* | `profiles` | a new `Profile` DTO (timezone) — consumed by `getToday()`, never rendered directly by the UI |
| *(no read DTO needed)* | `movements`, `goal_contributions` | surface only in Phase 7 mutation UI |

**`movements` was not needed by any Phase 6 read.** `Transaction.movementId` is a plain FK-backed
column on the `transactions` row itself (§4) — no Phase 6 query joins to `movements`, so the
table's Phase 4 posture (no `authenticated` grant, no RLS policy — §1, `rls-policies.md`) is
unchanged by the DAL swap. A transfer/credit-card-payment pair's two legs remain independently
visible wherever their own `account_id` puts them, through the ordinary `getTransactions()` path.

**Phase 7 CP4 changed that, for the edit surface only.** `lib/data/movements.ts` adds
`getMovements(ids)` and a `Movement` DTO — kind, date, source account, destination account, both
leg ids, and one **positive magnitude**. Which leg is the source is derived here, once, from the
legs' signs, rather than re-derived by each consumer; the signed amounts are not on the DTO at
all. The reason it reads by *movement id* rather than by pairing two rendered rows is the
`/transactions` reveal window: a movement's two legs routinely straddle its edge, so a form
reconstructed from the rows on screen would work by accident and would offer no edit control on
exactly the pairs that are hardest to find by hand. Ordering is `id ASC` — a technical order
only, since the caller looks these up by id and never renders them as a list. Anything that is
not a well-formed pair is `data_integrity`: `validate_movement()` guarantees the shape, so a
violation means the database contradicted its own invariant.

**Ten of the eleven existing DTOs are unchanged.** That's the direct payoff of deriving values
into the same shape rather than exposing normalized rows to the UI — and it's why
`lib/finance/**` and all 66 existing tests survive this design untouched. SQL primary keys are
`UUID`; DTO `id` fields remain plain `string`, so this is transparent to every consumer.

---

## 16. DAL function mapping

All ten functions below are Supabase-backed as of Phase 6; `lib/mock/dal.ts` is retained only as
the `test:parity` oracle, never called from production code.

| Function (`lib/data/**`) | Query | Note |
|---|---|---|
| `getToday()` | `profiles.timezone` + `Intl.DateTimeFormat('en-CA', …).formatToParts()` | The single clock seam — unchanged signature; `lib/data/clock.ts` (§10) |
| `getAccounts()` | `SELECT ... FROM account_balances WHERE user_id = $1 ORDER BY name ASC, id ASC` | `lib/data/accounts.ts`; explicit ordering, not fixture array order |
| `getCategories()` | `WHERE user_id = $1 ORDER BY name ASC, id ASC` | `lib/data/categories.ts` |
| `getTransactions(filters)` | `WHERE` clause + `ORDER BY date DESC, created_at DESC, id ASC`, `range()`-bounded | `lib/data/transactions.ts`; includes the Phase 3 `from`/`to` bounds and the Phase 6 `limit`/`offset` window (§ below); `search` is `ILIKE` with escaped wildcards — no `pg_trgm` (§8) |
| `getRecentTransactions(limit)` | `ORDER BY date DESC, created_at DESC, id ASC LIMIT n` | `lib/data/transactions.ts`; a real `LIMIT`, not a client-side slice of an unbounded fetch |
| `getBudgets(period)` | `WHERE period = $1 ORDER BY category_id ASC` | `lib/data/budgets.ts`; technical order only — callers apply their own semantic order (§17) |
| `getBills()` | Two queries: active `bills`, then their `scheduled` `bill_occurrences`, reduced to one occurrence per bill in TypeScript, sorted `due_date ASC, name ASC, id ASC` | `lib/data/bills.ts`; the one non-trivial rewrite in this table — a DAL projection, not a view (§13, §1) |
| `getUpcomingBills(limit)` | Derived from `getBills()`, sliced to `limit` | `lib/data/bills.ts`; the sort key is the projected due date, which no single relation carries, so the database cannot correctly truncate this list itself |
| `getGoals()` | `goal_balances`, `WHERE user_id = $1 AND archived_at IS NULL ORDER BY target_date ASC NULLS LAST, name ASC, id ASC` | `lib/data/goals.ts` |
| `getNetWorthHistory(months?)` | `ORDER BY month DESC` + `LIMIT n` (only for `months > 0`), reversed in TypeScript for chronological (ASC) display | `lib/data/net-worth.ts`; `months === 0` returns full history, matching the fixture oracle's `slice(-0)` behavior |

**`getAccountById` and `getTransactionsForMonth` were deleted in Phase 3** (superseded by
`getTransactions({ from, to })`) and are not part of this mapping — the table above reflects the
current `lib/data/**` surface, not the Phase 2 draft that preceded that cleanup.

**Transaction bounded-window reads (Phase 6 Checkpoint 4):** `/transactions` (`app/(app)/transactions/page.tsx`)
reads a cumulative-reveal prefix, never an unbounded full-history fetch. Each "Load more" press
increases a `revealed` count by `PAGE_SIZE` (25); the page re-reads `offset: 0, limit: revealed + 1`
as one contiguous read of one ordering (the `+1` is a has-more probe row, never rendered), split
into consecutive `MAX_TRANSACTION_LIMIT`-sized DAL queries by `fetchPrefix`/`iterateFetchWindows`
(`lib/data/filters.ts`) so no single `getTransactions()` call is ever unbounded. There is no
maximum reveal depth — only a ceiling on the size of any one underlying query. Changing a filter
resets `page` client-side (`components/transactions/transaction-filters.tsx` deletes the `page`
search param), so a new filter always starts from the first window.

**Explicit ordering is now a verified contract, not an accident of fixture-file layout** — every
list-returning function above has an explicit `ORDER BY`-equivalent chain, matching §17.

---

## 17. Fixture / invariant traceability

Every assertion in `lib/mock/index.test.ts` mapped to its schema-level enforcement:

| Fixture-test assertion | Enforced by |
|---|---|
| Every `movementId` appears on exactly two legs, summing to zero | Deferred constraint trigger (§7) |
| Movement legs' `kind` matches within a pair | Deferred constraint trigger (§7), asserts 3 |
| Movement legs never carry a `categoryId` | `CHECK`: `movement_id IS NOT NULL → category_id IS NULL` (§6) |
| Every referenced `categoryId` exists in `mockCategories` | Composite FK `(category_id, user_id) → categories(id, user_id)` (§3) |
| Sign invariant holds by `kind` (`income`/`refund` ≥ 0, `expense` ≤ 0) | `CHECK` constraints on `transactions` (§6) |
| Latest net-worth snapshot matches current account totals under the stated convention | Not a schema-level constraint — this is a **cross-table** consistency property between `account_balances` and `net_worth_snapshots` that the snapshot writer must preserve at write time; recorded here as a gap the trigger/CHECK layer does not close, by design (RLS and constraints protect row-level integrity, not cross-table business consistency) |
| Every goal's `savedCents`/`targetCents` and every account's `balanceCents` are safe integers | `toCents()` at the DB→TS mapper boundary (§9) — a schema-level `BIGINT` cannot itself guarantee JS safe-integer range, so this check remains at the application boundary exactly as it is today |

### Fixture legality check — `txn-094` and the movement pairs

`txn-094` (`lib/mock/transactions.ts`) is `{ accountId: "acc-cash", kind: "expense",
amountCents: 0, categoryId: undefined }` — a zero-amount, deliberately uncategorized ordinary
expense. Walked against §6's constraints:

- `kind = 'expense' → amount_cents <= 0` — `0 <= 0` ✓ (constraint is non-strict specifically
  because of this row)
- `kind IN ('transfer','credit_card_payment') → amount_cents <> 0` — does not apply; `kind` is
  `expense` ✓
- `movement_id IS NOT NULL → category_id IS NULL` — vacuously true, `movement_id` is null ✓
- No "must have a category" constraint exists, so `category_id IS NULL` here is legal ✓

Every fixture movement pair (e.g. `mov-transfer-2026-03`, `mov-ccpay-2026-03`) — two legs, same
`movement_kind`, opposite nonzero signs summing to zero, no category — satisfies every §6/§7
constraint directly, since those constraints were derived from this exact fixture shape.

### Phase 3 — the finalized transaction ordering contract

**The Phase 2 schema omitted `transactions.created_at`.** **Phase 3's deterministic-ordering
review exposed that `transactions` needed an entry-recency tie-break for same-day rows**: without
it, same-day transactions had no real tie-break and `ORDER BY date DESC, id ASC` alone would have
ordered tied rows by UUID. Phase 3 amended the schema to add `transactions.created_at` (see the
table in §4), and `lib/data/transactions.ts` was updated to sort `date DESC, created_at DESC, id
ASC` (the mock
DAL's `created_at` stand-in is the fixture array's own insertion index — a later fixture entry is
treated as a later `created_at`). This is what makes same-day rows (three transactions each on
`2026-08-16` and `2026-08-18` in the fixtures) deterministic instead of depending on
`Array.prototype.sort`'s stability, which SQL does not provide.

**Implemented in Phase 4:** `supabase/seed.sql` assigns explicit, strictly increasing `created_at`
timestamps to seeded transaction rows, following `mockTransactions` array order exactly — so the
seeded/database-backed application reproduces the same same-day transaction order this phase
established and tested, rather than silently reordering it.

---

## 18. Known future limitation — balance reconciliation

The derived-balance model in §11 (`opening_balance_cents + SUM(ledger)`) assumes every change to
an account's balance can be faithfully represented as an ordinary transaction. That assumption
holds for the current fixture domain (salary, rent, groceries, transfers, card payments) but
**does not hold in general**:

- **Investment market-value changes** — a brokerage account's balance moves with market prices,
  not with cash transactions.
- **Loan-interest accrual** — interest capitalizing onto a loan balance is not a transfer from
  anywhere.
- **Bank-reconciliation differences** — a synced balance may simply disagree with the computed
  ledger sum, for reasons outside the ledger (bank-side fees, timing, errors).

None of these are naturally an `income`/`expense`/`transfer`/`credit_card_payment` row, and
forcing them into that model would corrupt income/spending/cash-flow reporting (they would either
inflate spending or income, or require an artificial category that means neither).

**Before bank synchronization or serious investment-account support is built, the roadmap needs
an auditable account-balance adjustment/reconciliation mechanism** — recorded in
[DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md) as a stated prerequisite — that must:

- affect the derived account balance (§11);
- **not** be counted as spending or income by `lib/finance/transactions.ts`'s
  `countsAsSpending`/`countsAsIncome`;
- preserve financial history (append-only, per the same principle as §12);
- **never** mutate prior transactions merely to force a balance to match an external source.

**Not designed or implemented in this phase.** No table for it exists in §1's table list — adding
one is explicitly out of scope until bank-sync or investment work is actually planned.

### Phase 7 CP3 — the enum label, and nothing else

CP3 added the `adjustment` label to `transaction_kind` (§2) and the two constraints that go with
it, and **stopped there deliberately**. What exists now is the *shape* an adjustment will have —
a signed amount on an account, no category, excluded from `countsAsSpending`/`countsAsIncome` by
`lib/finance/transactions.ts` — so the read path, the DTO union, the `/transactions` filter, and
the badge all handle one safely before one can exist.

What does **not** exist, and is CP5's work: any way to create an adjustment. The ordinary entry
form offers `income`/`expense`/`refund` only, `lib/data/mutations/transactions.ts` types its kind
as `OrdinaryTransactionKind` so `adjustment` cannot be spelled there at all, and
`transactions_update_own_ordinary` refuses both to target an existing adjustment and to turn an
ordinary row into one. Adjustment **`DELETE` is deliberately left possible**: reconciliation is
delete-and-rewrite, and a superseded adjustment has to be removable or re-reconciling an account
would stack them forever.

The four requirements listed above are unchanged and still unmet as a whole — in particular,
nothing yet decides *when* an adjustment is written or how a reconciliation is recorded and
audited.

---

## 19. Bill payment provenance (Phase 8 CP1)

Through Phase 7 CP7, an occurrence's `transaction_id` was a *reference and only a reference*: the
owner picked one of their own transactions and the occurrence pointed at it. Phase 8 CP1 keeps
that case exactly as it was and adds a second one â€” a transaction this application **creates** when
an occurrence is settled â€” which makes "where did this reference come from?" a question the schema
has to be able to answer.

### The invariant that changed, stated precisely

CP7's rule was *bill tracking creates no ledger activity, ever*. The rule now is narrower, and the
narrowing is deliberate rather than an erosion:

| Operation | Ledger effect |
| --- | --- |
| Generating a `scheduled` occurrence | **None.** An unmet obligation is a projection. |
| Creating / editing / archiving / unarchiving a **bill** | **None.** Defining an obligation is not an economic event. |
| `scheduled â†’ skipped`, and back | **None.** Nothing was paid. |
| `scheduled â†’ paid`, existing transaction linked | **None.** The reference alters nothing about that transaction. |
| `scheduled â†’ paid`, bill names a usable account | **One `expense` row created**, recorded as `generated`. |
| `scheduled â†’ paid`, bill names no usable account | **None.** Paid, with no ledger row â€” the CP7 behaviour, unchanged. |
| `paid â†’ scheduled`, origin `generated` | **That row deleted**, in the same transaction. |
| `paid â†’ scheduled`, origin `linked` | **None.** The reference is cleared; the transaction is never deleted. |

"A usable account" means the bill's `account_id` is non-null **and** that account is not archived.
An archived account is a fallback to status-only rather than a refusal: `assert_transaction_refs()`
would reject a row posted into one, and blocking the settlement over it would leave a person unable
to record a payment they actually made.

### `bill_occurrences.transaction_origin`

| Column | Type | Nullability | Notes |
| --- | --- | --- | --- |
| `transaction_origin` | `public.bill_payment_origin` | nullable | `'linked'` or `'generated'`. Non-null **exactly when** `transaction_id` is (`bill_occurrences_transaction_origin_ck`). |

Provenance is a stored fact rather than a client claim, and it is **unforgeable**:
`guard_bill_occurrence_transition()` accepts `'generated'` only when the referenced transaction's
`created_at` equals `now()` â€” `transaction_timestamp()`, fixed for the whole database transaction,
and the same default `transactions.created_at` takes. So the label holds only for a row inserted by
the very transaction performing the update. `authenticated` has no grant on
`transactions.created_at` on INSERT *or* UPDATE, so there is no statement available to that role
that could manufacture a qualifying row.

The consequence worth stating plainly: **a transaction the owner wrote by hand can only ever be
marked `linked`, and a `linked` transaction is never deleted by any path.** That is a structural
property, not an application rule.

Existing rows were backfilled as `'linked'` by the migration, which is both correct (nothing could
generate one before it) and the conservative direction.

### The two settlement functions

`public.settle_bill_occurrence(p_occurrence_id, p_paid_on, p_transaction_id, p_generated_transaction_id)`
and `public.unsettle_bill_occurrence(p_occurrence_id)`. Both are `SECURITY INVOKER` with
`search_path = ''`, both derive the owner from `auth.uid()`, and neither takes an owner, an
account, a category, a merchant, an amount or a kind â€” every fact about the ledger row they may
write is read from the occurrence and its bill. They exist because the status change and the
ledger row must commit together: PostgREST issues one statement per request in its own
transaction, so two calls could leave a paid occurrence with a phantom reference or an orphan
expense.

The generated row is an ordinary expense in every respect:

| Field | Source |
| --- | --- |
| `amount_cents` | negated **occurrence** amount â€” never the parent bill's current amount (Â§13) |
| `account_id` | the bill's account |
| `category_id` | the bill's category **when it is an active expense category**, otherwise null |
| `date` | `paid_on` |
| `merchant` | the bill's name, verbatim |
| `kind` | the literal `'expense'` |
| `movement_id` | null â€” an ordinary row, reachable from the ordinary transaction surface |

The category rule is the one asymmetry: a bill's category kind is deliberately unconstrained (Â§13,
`assert_bill_refs()`), while an expense transaction's is not. When the bill's category cannot
legally label an expense the row is created uncategorized rather than the settlement being refused
â€” an uncategorized expense is legal, visible and one edit from correct, while a refusal is a dead
end.

### Idempotency, in three layers

1. **An already-`paid` occurrence is a no-op that reports success**, checked before anything is
   inserted. This is the layer that fires for a retry after a lost response, a double-clicked
   button, or a replayed request â€” and it is what makes "marking paid twice never creates a second
   transaction" true regardless of what the second submission carries. It also means correcting a
   paid date is unmark-then-mark-again rather than a second mark.
2. **`p_generated_transaction_id` is a client-minted UUID** used verbatim as the new row's `id`, so
   a torn retry that somehow reached the INSERT collides with itself on the primary key.
3. **The settling UPDATE carries `status = 'scheduled'` in its own `WHERE`** and the row count is
   checked, so two simultaneous requests cannot both settle one occurrence â€” the second matches
   zero rows and rolls its own inserted transaction back with it.

### Verification

`supabase/tests/database/200-bill-payment-ledger.sql` (44 assertions) and
`tests/mutations/bill-occurrences.test.ts` (29 tests, including a block that reads every balance,
total, cash-flow figure, net worth and snapshot back before, during and after a generated payment).

---

## 20. Monthly plans (Phase 8 CP2)

`public.monthly_plans` stores one figure â€” what the owner **expects** to earn in a given month â€” so
`/budgets` can start from income rather than from a list of spending limits.

| Column | Type | Nullability | Notes |
| --- | --- | --- | --- |
| `id` | `UUID` | NOT NULL, PK | `gen_random_uuid()` default; client-minted on insert, as every other create surface here |
| `user_id` | `UUID` | NOT NULL | FK â†’ `profiles(id)` `ON DELETE CASCADE` |
| `period` | `TEXT` | NOT NULL | `'YYYY-MM'`, same `CHECK` as `budgets.period` |
| `expected_income_cents` | `BIGINT` | NOT NULL | `>= 0` â€” a magnitude; an expectation has no direction |
| â€” | | | `UNIQUE (user_id, period)` â€” the natural key, one target per month |
| â€” | | | `UNIQUE (id, user_id)` â€” the composite shape every table here carries; nothing references it today |

No `created_at`, matching `budgets` and `categories`: nothing orders these rows by entry time.

### Why not a `budgets` row

Four independent reasons, any one of which is sufficient:

1. `assert_budget_category_active_expense()` refuses a budget whose category is not an active
   *expense* category. Storing income there means weakening that trigger or inventing a sentinel
   category.
2. Every consumer of `getBudgets()` treats a row as a spending limit â€” `budgetStatus()` compares it
   against `spendingByCategory()`, `/budgets` renders a utilisation meter, and the dashboard sums
   them. An income row would appear as a permanently 0%-used expense budget.
3. A budget is per *category*; expected income is per *month*. Forcing a category onto it invents a
   dimension the concept does not have, and `(user_id, category_id, period)` would then permit
   several contradictory targets for one month.
4. "Total planned expense budgets" â€” the figure the whole summary is built around â€” would have to
   start excluding one magic row.

### What it is not

- **Not income.** Actual income stays `monthlyIncome()` over `kind = 'income'` transactions.
  Nothing in `lib/finance/transactions.ts` reads a plan.
- **Not a balance.** `private.write_net_worth_snapshot` sums accounts and transactions; the writer
  role holds no grant on this table at all (`090-privileges.sql` asserts it), so an expected figure
  cannot reach net worth even by accident.
- **Not referenced by anything.** No foreign key in this schema points at `monthly_plans`, and it
  points only at `profiles` â€” proven directly in `210-monthly-plans.sql`.

### "Not set" is a state, and it is not zero

A month with no plan has **no row**, and `getMonthlyPlan()` returns `undefined` rather than a
zeroed plan. Zero expected income makes every planned expense unallocated, which is a real answer;
"not set" is the absence of one, rendered as "â€”". The `DELETE` grant exists so a person can return
to it â€” without one there would be no way back.

### The summary the page renders

`monthlyPlanSummary()` (`lib/finance/planning.ts`) is pure and takes the plan, the month's budgets,
the transactions and the period. It **calls** `monthlyIncome`, `monthlySpending` and
`monthlyCashFlow` rather than reimplementing them, so a plan can never disagree with the dashboard
about what a month earned:

```
unallocated = expectedIncome âˆ’ Î£(budget.limitCents)      (undefined when no plan is set)
```

Negative unallocated is a real, useful state â€” the budgets add up to more than the month expects to
earn â€” and is never clamped.

### Verification

`supabase/tests/database/210-monthly-plans.sql` (25 assertions), `lib/finance/planning.test.ts`,
`lib/validation/monthly-plans.test.ts`, and `tests/mutations/monthly-plans.test.ts` (17 tests).
