# Database Schema Design

This design is now **implemented** — see `supabase/migrations/20260822150001`–`...150008` for the
executable SQL and [DEVELOPMENT_PLAN.md §Phase 4](../DEVELOPMENT_PLAN.md#phase-4--supabase-provisioning--migrations--complete)
for the verified completion facts (migration counts, hosted verification, test results). This
document remains the authoritative *design* narrative — the reasoning behind each decision — while
the migrations are the authoritative *executable* source; small illustrative SQL snippets below
predate the migrations and are kept only where they still clarify a shape or a constraint's intent,
not as a claim that they're what actually shipped. See
[DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md) for phase sequencing and
[docs/rls-policies.md](rls-policies.md) for security. The application (`lib/data/**`) is still
mock-fixture-backed — the DAL swap to these tables is Phase 6, not done yet.

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
            └──< net_worth_snapshots
```

**Eleven tables:** `profiles`, `accounts`, `categories`, `movements`, `transactions`, `budgets`,
`bills`, `bill_occurrences`, `goals`, `goal_contributions`, `net_worth_snapshots`.

**Two views**, both `security_invoker = on`, both implemented in
`20260822150005_views.sql`
(see [rls-policies.md](rls-policies.md#security_invoker-views)):

- `account_balances` — derived current balance per account.
- `goal_balances` — derived `saved_cents` per goal.

**Decided in Phase 4:** the bill next-unpaid-occurrence projection is **not** a view — it remains
a Phase 6 DAL query, per §13/§16.

No table list changed across the review rounds that produced this document — the balance-
reconciliation limitation (§18) is recorded as a *future* prerequisite, not a table added now.

---

## 2. Enums

| Enum | Values | Note |
|---|---|---|
| `account_type` | `checking`, `savings`, `cash`, `credit`, `investment`, `loan` | Matches `AccountType` in `lib/types/index.ts` |
| `transaction_kind` | `income`, `expense`, `refund`, `transfer`, `credit_card_payment` | Matches `TransactionKind` |
| `movement_kind` | `transfer`, `credit_card_payment` | **Deliberately narrower** than `transaction_kind` — makes "a movement can only be one of the two paired kinds" a type-level fact, not a runtime check |
| `bill_frequency` | `weekly`, `biweekly`, `monthly`, `yearly` | Matches `BillFrequency` |
| `category_kind` | `income`, `expense` | Matches `Category.kind` |
| `bill_occurrence_status` | `scheduled`, `paid`, `skipped` | New — no current DTO equivalent |

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
| `category_id` | `UUID` | **nullable** | Composite FK → `categories(id, user_id)`. Null on movement legs *and* legally on some ordinary rows — see `txn-094`, §17 |
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
| `transaction_id` | `UUID` | nullable | Composite FK → `transactions(id, user_id)`, `ON DELETE RESTRICT`. Nullable because an occurrence may be marked paid without a linked imported transaction (§13) |
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
  `kind = 'expense' → amount_cents <= 0`. **Non-strict** — a legal fixture row has
  `amount_cents = 0` on an `expense` (§17).
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
| `transactions` | trigram index on `merchant` | Deferred — needs the `pg_trgm` extension. `TransactionFilters.search` is a substring match; flagged as a Phase 6 verification item, not designed here. |
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
  `profiles.timezone`**, never the server's clock. **Not implemented in this phase** — recorded
  here as the intended Phase 6 strategy, not a promise about any single API call's exact output
  format: construct `Intl.DateTimeFormat` with explicit `{ timeZone: tz, year: 'numeric', month:
  '2-digit', day: '2-digit' }`, call `.formatToParts()` rather than `.format()`, and explicitly
  assemble the `year`/`month`/`day` parts into a `'YYYY-MM-DD'` string. `Intl.DateTimeFormat`'s
  locale-formatted string output (even with locale `'en-CA'`) is not guaranteed across
  environments to be exactly machine-parseable `YYYY-MM-DD` — separators, part order, and
  padding are locale/implementation details. `formatToParts()` gives structured
  `{ type, value }` parts to assemble explicitly instead of relying on that string shape.
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
deletion path, not the application's primary guard. **Document required trigger behavior only —
no trigger SQL is written in this phase**, consistent with the movement trigger (§7) and
timezone-validation trigger (§10).

### Phase 7 — what a later bill edit is and isn't allowed to do

Not implemented now; recorded so the eventual mutation logic has a stated rule to follow rather
than inventing one under time pressure:

- If a recurring bill's default amount, frequency, or anchor date changes, **future `scheduled`
  occurrences may be regenerated or updated** to reflect the new terms — that's a legitimate use
  of the fact that they haven't happened yet.
- **`paid` and `skipped` occurrences must never be silently rewritten** by a change to the parent
  bill. Their `amount_cents` was fixed at generation time specifically so this couldn't happen.

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
`UNIQUE (bill_id, due_date)` so re-running the generator never duplicates. **The generator itself
is not built in this phase** — it arrives with the snapshot writer in Phase 4.

### DTO projection — how the existing `Bill` shape survives Phase 6 unchanged

Today, `Bill` ([lib/types/index.ts](../lib/types/index.ts)) is one object carrying `dueDate`
directly, and `billStatus(bill, today)` (`lib/finance/bills.ts`) reads that field. Bills is **the
only** locked decision that changes storage cardinality — a naive one-to-one port of the new
model would ripple through `lib/types`, `lib/finance/bills.ts` and its tests,
`components/bills/**`, `components/dashboard/upcoming-bills.tsx`, and both consuming pages.

**Resolution:** the schema satisfies the "no mutable pointer, full history retained" requirement
completely at the storage layer. The **Phase 6 DAL** then projects the next unpaid occurrence
into the existing `Bill` DTO shape — `dueDate` becomes "the earliest `scheduled` occurrence's
`due_date` for this bill," computed at query time. **Decided in Phase 4: this projection is a
Phase 6 DAL query, not a third view** — `20260822150005_views.sql` creates exactly the two views
in §1 (`account_balances`, `goal_balances`). `BillOccurrence` does not enter the UI, and no
component changes, until Phase 7 actually needs occurrence history or a mark-as-paid action.

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

**Ten of the eleven existing DTOs are unchanged.** That's the direct payoff of deriving values
into the same shape rather than exposing normalized rows to the UI — and it's why
`lib/finance/**` and all 66 existing tests survive this design untouched. SQL primary keys are
`UUID`; DTO `id` fields remain plain `string`, so this is transparent to every consumer.

---

## 16. DAL function mapping

| Function (`lib/data/**`) | Future query | Note |
|---|---|---|
| `getToday()` | `profiles.timezone` + `Intl.DateTimeFormat('en-CA', …)` | The single clock seam — unchanged signature |
| `getAccounts()` | `SELECT * FROM account_balances WHERE user_id = auth.uid() ORDER BY name` | Ordering is currently implicit in fixture array order — must become an explicit contract |
| `getCategories()` | `WHERE user_id = auth.uid() ORDER BY name` | Same explicit-ordering requirement |
| `getTransactions(filters)` | `WHERE` clause + `ORDER BY date DESC, created_at DESC, id ASC` | Maps 1:1 today, including the Phase 3 `from`/`to` bounds; `search` needs `pg_trgm` (§8) |
| `getRecentTransactions(limit)` | `ORDER BY date DESC LIMIT n` | Currently fetches the full unbounded list and slices client-side — becomes a real `LIMIT` |
| `getBudgets(period)` | `WHERE period = $1` | 1:1 |
| `getBills()` | `bills` joined to each bill's next unpaid occurrence (§13) | The one non-trivial rewrite in this table — a Phase 6 DAL query, not a view (§13, §1) |
| `getUpcomingBills(limit)` | `bill_occurrences ORDER BY due_date LIMIT n` | Wired into the Dashboard as of Phase 3, replacing an unbounded `getBills()` + sort + slice |
| `getGoals()` | `goals` + `goal_balances` rollup, `WHERE archived_at IS NULL` | The soft-delete filter is new; everything else maps directly |
| `getNetWorthHistory(months?)` | `ORDER BY month DESC LIMIT n`, reversed for chronological display | Currently implemented as `.slice(-months)` over the full fixture array |

**`getAccountById` and `getTransactionsForMonth` were deleted in Phase 3** (superseded by
`getTransactions({ from, to })`) and are not part of this mapping — the table above reflects the
current `lib/data/**` surface, not the Phase 2 draft that preceded that cleanup.

**Implicit ordering is a latent bug, not a feature.** Several fixture-backed functions today
return arrays whose order is an accident of fixture-file layout. SQL guarantees no ordering
without an explicit `ORDER BY`; every list-returning function needs one, or the UI will reorder
unpredictably the moment the DAL swap lands.

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
