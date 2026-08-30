# Row Level Security & Privilege Design

Documentation only — no migration-ready SQL. Small illustrative snippets appear where they
clarify intent; nothing here is meant to be run as-is. See
[docs/database-schema.md](database-schema.md) for tables/constraints and
[docs/auth-design.md](auth-design.md) for the authentication layer this security model sits under.

## Contents

1. [Ownership model](#1-ownership-model)
2. [Two separate layers: GRANT and RLS](#2-two-separate-layers-grant-and-rls)
3. [Least-privilege grants, Phases 4–6](#3-least-privilege-grants-phases-46)
4. [Operation-specific RLS policies](#4-operation-specific-rls-policies)
5. [What RLS cannot enforce](#5-what-rls-cannot-enforce)
6. [Composite FK role](#6-composite-fk-role)
7. [Movement trigger role](#7-movement-trigger-role)
8. [FORCE ROW LEVEL SECURITY strategy](#8-force-row-level-security-strategy)
9. [SECURITY DEFINER, BYPASSRLS, and the snapshot writer](#9-security-definer-bypassrls-and-the-snapshot-writer)
10. [`security_invoker` views](#10-security_invoker-views)
11. [EXECUTE privilege rules for functions](#11-execute-privilege-rules-for-functions)
12. [No `service_role` in application code](#12-no-service_role-in-application-code)
13. [What Phase 8 added](#13-what-phase-8-added)

---

## 1. Ownership model

`profiles.id` is both primary key and `REFERENCES auth.users(id)`, so the ownership predicate is
uniform across the schema:

```
auth.uid() = user_id          -- every table except profiles
auth.uid() = id                -- profiles only
```

**Phase 4 implementation note — performance, not semantics.** The predicate above is the
*semantic* ownership rule and is what this document and `database-schema.md` mean everywhere
they write `auth.uid() = user_id`. When policies are actually written in Phase 4, prefer the
Supabase-recommended form `(select auth.uid()) = user_id` — wrapping the call lets Postgres
evaluate `auth.uid()` once per statement (as an initPlan) rather than re-evaluating it once per
row scanned. This changes nothing about which rows a policy matches; it is purely a query-planning
detail, recorded now so Phase 4 doesn't have to rediscover it.

Cross-table ownership (a transaction's account belongs to the same user as the transaction) is
**not** an RLS concern — RLS filters rows on one table at a time. That relationship is enforced
structurally by composite foreign keys (§6) and, where cross-row validation is needed, by the
movement trigger (§7). RLS's job here is narrower and more specific: given a row a query is
already permitted to touch, restrict it to rows this user owns.

---

## 2. Two separate layers: GRANT and RLS

These are independent controls and both are required — relying on RLS alone is not a
least-privilege strategy, because RLS only ever runs on an operation the role is already
permitted to attempt.

> **`GRANT` determines whether a role can perform an operation at all.**
> **RLS then determines which rows a permitted operation can affect.**

A role with no `GRANT SELECT` on a table gets a permission-denied error before RLS is even
consulted. A role *with* `GRANT SELECT` but no matching RLS policy on an **RLS-enabled** table
gets zero rows back, not an error — Postgres default-denies when RLS is enabled and no policy
applies. This is a **very different failure mode** from a missing grant, and it is precisely why
both layers matter, stated correctly:

> **`GRANT` alone does not provide row-level ownership isolation.** If RLS is **disabled** on a
> table, a `GRANT SELECT` exposes every row to that role under the ordinary Postgres privilege
> system — nothing filters rows by owner. If RLS is **enabled** but no applicable policy exists,
> Postgres default-denies and the grant yields zero rows, not every row.

The two-layer design is still both-required, for a different reason than "an unguarded grant
leaks everything": `GRANT` is what makes an operation reachable at all, and RLS is what makes a
reachable operation return only this user's rows — omitting either produces a broken table
(unreachable, or reachable but never returning anything), not automatically a leaking one.
**The actual risk this design guards against is `FORCE ROW LEVEL SECURITY` being disabled, or the
table's RLS being turned off entirely, while a broad `GRANT` remains in place** — see §8 for why
`FORCE` is applied consistently.

Concretely for this schema: `authenticated` gets `GRANT SELECT` on the user-facing tables and
views it needs (§3), and nothing else, for as long as Phases 4–6 last, and RLS is `ENABLE`d and
`FORCE`d on every one of those tables (§8) so the ownership predicate in §4 actually applies. A
grant on a table where RLS was never enabled would expose every row; a policy on a table
`authenticated` has no grant for is unreachable dead configuration. Both failure modes are worth
naming precisely, since "leaks every row" and "returns zero rows" call for very different fixes.

---

## 3. Least-privilege grants

| Role | Table/view access | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `anon` | **None** on any user-financial table or view. | ❌ | ❌ | ❌ |
| `authenticated` | `SELECT` on every table (`movements` included as of CP4), plus **column-scoped** `INSERT` on `accounts`, `categories`, `transactions`, `movements`, `budgets`, `goals`, `goal_contributions` and `bills`; `UPDATE` on all of those except `movements` and `goal_contributions`, plus `bill_occurrences`; and `DELETE` on `transactions`, `movements` and `budgets` only. | accounts, categories, transactions, movements, budgets, goals, goal_contributions, bills | accounts, categories, transactions, budgets, goals, bills, **bill_occurrences** | **transactions, movements, budgets** |

Through Phases 4, 5, and 6 this was `SELECT` only, without exception: there was no mutation UI, no
Server Action, and no application code path that wrote to the database, so there was no reason for
`authenticated` to hold write grants on anything. Granting them "in case" would have handed a
compromised or misused browser session write access years before the application used it.

**Phase 7 adds object grants and operation-specific RLS policies together, per mutation, as each
one is actually implemented** — never in advance of the corresponding feature. See §4's matrix for
which operation lands with which feature.

### What Phase 7 CP2 actually granted

`supabase/migrations/20260827120001_account_category_writes.sql`, and nothing else so far. Every
grant is column-scoped (see §4 for why that is a `GRANT` concern and not an RLS one):

| Table | `INSERT` columns | `UPDATE` columns |
|---|---|---|
| `accounts` | `user_id`, `name`, `institution`, `type`, `opening_balance_cents`, `credit_limit_cents`, `interest_rate_bps` | `name`, `institution`, `credit_limit_cents`, `interest_rate_bps`, `opening_balance_cents`, `is_archived` |
| `categories` | `user_id`, `name`, `kind` | `name`, `kind`, `is_archived` |

The exclusions carry the design:

- **`id` and `created_at` are in neither list.** Both have defaults, and a column absent from a
  column-scoped `INSERT` grant simply takes its default rather than failing — so omitting them
  costs nothing and removes any way to choose a row's id or backdate it.
- **`user_id` is `INSERT`-only.** The ownership predicate needs it assignable for a row to be
  insertable at all; leaving it out of `UPDATE` is what makes re-homing a row unreachable rather
  than merely policy-checked.
- **`accounts.type` is `INSERT`-only** — it decides asset/liability classification, which optional
  columns are even legal, and how every historical snapshot already classified the account.
  `categories.kind` *is* updatable, but only while the category is unreferenced
  (`guard_category_kind_change()`; see database-schema.md §6).
- **`is_archived` is `UPDATE`-only on both.** Neither may be *created* already archived.
- **No `DELETE` grant on either table**, matching §4's "prefer archive" row.

`anon` is not named in a single GRANT or policy in that migration. The complete privilege matrix
is asserted table by table and column by column in
`supabase/tests/database/100-write-grants.sql`, which also proves its own table list is complete.

### What Phase 7 CP3 added

`supabase/migrations/20260828120002_transaction_writes.sql` — one table, and the first `DELETE`
grant in this schema:

| Table | `INSERT` columns | `UPDATE` columns | `DELETE` |
|---|---|---|---|
| `transactions` | `id`, `user_id`, `account_id`, `date`, `merchant`, `kind`, `category_id`, `movement_id`, `amount_cents` | `account_id`, `date`, `merchant`, `kind`, `category_id`, `amount_cents` | ✅ table-level, narrowed by policy |

Four things about that row carry the design:

- **`id` is grantable on `INSERT` here and nowhere else.** Ordinary transaction creation is the
  first operation in this application where a double submit produces a *real* duplicate — two
  coffees, same amount, same day, both plausible — so nothing about the row's contents could
  distinguish a retry from a second purchase. The create form therefore generates one
  client-side UUID per logical submission and posts it as the row's id, so a retry collides with
  itself on the primary key instead of inserting a second row.
  `lib/data/mutations/transactions.ts` turns that `23505` into either "this is my own identical
  row, the first attempt won" or a refusal — never a blind success. There is no idempotency
  table and no middleware: the primary key already enforces uniqueness, transactionally.
- **`movement_id` is `INSERT`-only and confers nothing yet.** The biconditional `CHECK` means an
  `INSERT` grant omitting it could not express a movement leg at all, so it is granted for CP4 —
  but `authenticated` has no `INSERT` on `public.movements`, so there is no parent to point at,
  and `validate_movement()` rejects any movement not ending the transaction with exactly two
  balanced legs.
- **`created_at` is in neither list.** It is the `date DESC, created_at DESC, id ASC` ordering's
  entry-recency tie-break; a backdatable one would silently reorder same-day history.
- **`DELETE` is table-level because PostgreSQL has no column-level `DELETE`.** The narrowing is
  entirely in the policy's `USING` predicate (§4). Transactions are deleted rather than archived
  because, unlike accounts/categories/bills/goals, a transaction is not a *label* historical rows
  resolve through — it *is* the history, a mistyped one has no correct archived state, and a
  "voided" flag would mean every balance, budget, KPI and chart growing a clause to exclude it.

### What Phase 7 CP4 added

`supabase/migrations/20260828120003_movement_writes.sql` — one table, `movements`, and the
first two functions `authenticated` may `EXECUTE` anywhere in this schema:

| Table | `SELECT` | `INSERT` columns | `UPDATE` | `DELETE` |
|---|---|---|---|---|
| `movements` | ✅ **CP4** | `id`, `user_id`, `kind` | ❌ **never** | ✅ table-level, narrowed by policy |

- **`SELECT` arrives now because the *edit* surface is the first thing that needs the parent.**
  Through Phase 6 there was deliberately no grant at all: `Transaction.movementId` is a plain
  column on the leg and nothing joined to `movements`. An edit form has to show the movement —
  a kind, a date, two accounts, one magnitude — rather than a leg, and it has to work when the
  two legs straddle the `/transactions` reveal window, so it reads the pair **by movement id**
  rather than by pairing two rendered rows. `SELECT` is also what lets `replace_movement`'s
  ownership check see a row at all, since a `SECURITY INVOKER` function has exactly the
  caller's visibility.
- **`id` is grantable on `INSERT`, for two reasons.** Movement creation is idempotent by a
  client-generated UUID, exactly as ordinary transaction creation is — and additionally,
  `replace_movement` re-creates the movement under its *original* id, so a movement id is
  stable for the movement's whole life and an edit never re-identifies the thing being edited.
- **There is no `UPDATE` grant and no `UPDATE` policy — permanently.** A `movements` row is
  `(id, user_id, kind)` and nothing else. `id` is its identity, `user_id` its owner, and `kind`
  is what every leg's own kind must equal (`validate_movement()` assert 3), so changing `kind`
  in place would either fail that assert or require rewriting both legs in the same breath.
  That is exactly what `replace_movement` does, by delete-and-recreate. Leaving `UPDATE`
  ungranted means there is no second, partial way to do it.
- **`DELETE` is the second and last `DELETE` grant in this schema**, and it is the *only*
  correct way to remove a transfer or card payment: `transactions_delete_own_non_movement`
  carries `movement_id IS NULL`, so a leg is invisible to `DELETE` outright, and deleting the
  parent cascades both legs through `transactions_movement_fk`.

**Why CP4 needs functions at all — and why they are not a convenience layer.** A movement is a
parent plus exactly two legs, and the database refuses every partial form of it: a childless
movement fails `movements_validate_movement` at `COMMIT`, and a leg naming a movement that does
not exist yet fails the **non-deferrable** composite FK immediately. PostgREST issues one
statement per request, each in its own transaction, so **no sequence of PostgREST calls can
produce a movement at all.** `public.create_movement` and `public.replace_movement` are
therefore the only reachable creation path, which is what makes the checks inside them a real
boundary rather than an application-layer suggestion. `140-movement-writes.sql` proves each half
of that claim directly.

Both are `SECURITY INVOKER` (§11), take **no owner parameter** — the owner comes from
`auth.uid()` inside the body — use `set search_path = ''` with every object schema-qualified,
have `EXECUTE` revoked from `PUBLIC` and `anon`, and are granted to `authenticated` alone.
`replace_movement` composes `create_movement` rather than sharing a helper in `private`,
because a `SECURITY INVOKER` body runs with the *caller's* privileges and `authenticated` has no
`USAGE` on `private` — a fact 090-privileges.sql now asserts for exactly this reason.

Deleting deliberately gets **no** function: it is genuinely one statement, and wrapping it would
add a privilege surface and no guarantee.

One account-type rule lives inside the RPCs, and it is no broader than the repository already
commits to: **a credit-card payment's destination must be a `credit` account**
(`lib/types/index.ts` states the convention — "source (checking) leg negative, destination (card)
leg positive" — and `lib/finance/accounts.ts` classifies `credit` as a liability stored
negative, so a payment is the movement that raises that balance toward zero). Nothing is
enforced about the *source*'s type: paying a card from cash, savings, or another card are all
things a person may legitimately record.

Functions/RPCs (the snapshot writer, the timezone-validation trigger function) get `EXECUTE`
revoked from `PUBLIC` by default — see §11.

---

### What Phase 7 CP5 added

`supabase/migrations/20260829120001_reconciliation.sql` and
`supabase/migrations/20260829120002_current_snapshot.sql` — and the headline is what they
*don't* contain: **no new table grant for `authenticated`, and no widening of an existing one.**
The table matrix above is byte-for-byte what CP4 left, and
`supabase/tests/database/100-write-grants.sql` still asserts it column by column.

Reconciliation is a new *operation over CP3's existing privileges*. CP3 already granted a
column-scoped `INSERT` covering `kind`, already made `adjustment` a legal stored kind
(`transactions_sign_by_kind_ck`'s unconstrained adjustment branch), and already left `DELETE`
possible on an adjustment — `transactions_delete_own_non_movement` carries only
`movement_id IS NULL` and says nothing about kind, which was deliberate so CP5 could reconcile
by remove-and-rewrite. What CP3 withheld was a *path* to writing one. CP5 adds exactly that
path, and it is a function.

| Function | Security | Parameters | `EXECUTE` |
|---|---|---|---|
| `public.reconcile_account(uuid, date, bigint)` | `INVOKER` | account, as-of date, desired internal balance | `authenticated` only |
| `public.refresh_current_net_worth_snapshot()` | **`DEFINER`**, owned by `finance_snapshot_writer` | **none** | `authenticated` only |
| `private.request_owner_id()` | `INVOKER` | none | `finance_snapshot_writer` only |

#### `reconcile_account` — why a function, given the `INSERT` grant already exists

A reconciliation is not "insert an adjustment". It is

```
delta := desired_internal_balance - (opening_balance_cents + SUM(transactions.amount_cents))
```

and *then* an insert of exactly `delta`, or of nothing at all when `delta` is zero. Computing
the current balance in the client and posting the difference would mean the number written to
the ledger was chosen from a balance read at some earlier moment, so a transaction entered in
another tab in between would leave the account reconciled to the wrong figure — with an
adjustment row that looks perfectly well-formed and simply is not. Deriving the delta inside
the database, in the same statement that writes the row, removes that window.

It is `SECURITY INVOKER` and needs nothing more: the caller already holds `SELECT` on accounts
and transactions and `INSERT` on transactions, and under FORCE RLS the invoker sees exactly its
own rows. The owner comes from `auth.uid()` and is never a parameter. `set search_path = ''`,
every name qualified, `EXECUTE` revoked from `PUBLIC` and `anon`.

Three rules are deliberately **left to the database rather than restated** inside it: the
posted-date ceiling in the owner's own timezone, the archived-account refusal (both
`assert_transaction_refs()`, CP3), and "an adjustment carries no category"
(`transactions_adjustment_no_category_ck`). Re-deriving the date ceiling here would mean two
expressions that must agree forever, and the trigger's is the one that also covers every other
write path.

**Liability input is normalized above the database, not inside it.** The parameter has exactly
one meaning — the desired *internal signed* balance — because a parameter whose interpretation
flipped based on a row it looked up would be a parameter no caller could reason about, and an
overpaid credit card (a legitimately positive balance on a `credit` account) is a real state
such a rule would make unreachable. Turning the UI's non-negative "amount currently owed" into
`-magnitude` happens in `lib/data/mutations/reconciliation.ts`, from the account's *stored*
type, never from anything the client sent.

**Idempotent without an idempotency key.** CP3 and CP4 both needed a client-minted UUID because
two identical coffees on the same day are a legitimate pair of rows. Reconciliation does not:
the second submission computes its delta against a balance the first already corrected, so the
delta is zero and no row is written.

#### `refresh_current_net_worth_snapshot` — the one `SECURITY DEFINER` this phase adds

Everything else in CP2–CP5 is `SECURITY INVOKER` because the caller already held what the body
used. This one cannot be: `private.write_net_worth_snapshot` is owned by
`finance_snapshot_writer`, `authenticated` has no `USAGE` on `private` at all, and
`net_worth_snapshots` has no `INSERT`/`UPDATE` grant for `authenticated` and never will. So the
bridge takes the writer's identity — and is kept as narrow as a bridge can be:

- **Zero parameters.** The caller can address neither another owner nor another month, not
  because a check rejects those arguments but because there are none. `pronargs = 0` is asserted
  in `090-privileges.sql`, so a defaulted parameter added later fails a test rather than
  quietly accepting a value.
- **Owned by `finance_snapshot_writer`**, never `postgres` — whose `BYPASSRLS` attribute would
  turn a browser-reachable function into an RLS bypass. The role keeps its Phase 4 attributes:
  `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, no application role a member.
- **`ALTER FUNCTION … OWNER TO` requires the incoming owner to hold `CREATE` on the schema**, so
  the migration grants `CREATE ON SCHEMA public` to the writer for that one statement and
  revokes it immediately. The ownership is permanent; the privilege is not, and
  `090-privileges.sql` asserts the role ends with no `CREATE` on `public`.
- **One new table privilege, column-scoped:** `SELECT (id, timezone)` on `profiles`, plus
  `profiles_select_writer` — narrower than the writer's other policies (`using (true)`), because
  here a tighter predicate is available for free: `using (id = private.request_owner_id())`. The
  writer sees the calling request's own profile row and no other, and a session with no claim
  (a cron job, a psql shell) sees none.
- **The month comes from that profile's timezone**, via
  `to_char((now() at time zone <the owner's zone>)::date, 'YYYY-MM')` — the same expression
  `assert_transaction_refs()` uses for its date ceiling and the same calendar day
  `lib/data/clock.ts` derives. Never server UTC.

**Why the owner is read from the JWT GUC rather than from `auth.uid()`.** Inside a
`SECURITY DEFINER` body the current role is the *owner*, so every function the body calls runs
as `finance_snapshot_writer` — including `auth.uid()`. That role has no `USAGE` on schema
`auth` (`set role finance_snapshot_writer; select auth.uid();` → *permission denied for schema
auth*), and the grant cannot be made from a migration either: schema `auth` is owned by
`supabase_auth_admin`, and the migration role does not hold `USAGE … WITH GRANT OPTION`, so
`grant usage on schema auth to finance_snapshot_writer` reports *"no privileges were granted"*
and changes nothing. Both facts were verified directly against the local Postgres 17.6 image.
The claim itself is not privileged — it is a GUC, readable through `pg_catalog` by any role — so
`private.request_owner_id()` reads it exactly as `auth.uid()` does.
`160-current-snapshot.sql` asserts the two agree, for a set claim, for an empty one, and for the
JSON `request.jwt.claims` form PostgREST actually uses, so the duplication cannot drift
silently.

**There is no historical rebuild surface.** `private.write_net_worth_snapshots_for_range` keeps
its Phase 4 posture — unreachable by `authenticated`, with no public wrapper of any kind — and
`160-current-snapshot.sql` asserts that `public` exposes exactly one function whose name
mentions a snapshot, and that it is the zero-argument bridge. Backfill stays an operator action.

### What Phase 7 CP6 added

`supabase/migrations/20260830120001_budget_goal_writes.sql` opened three more tables, each with
a deliberately different shape: `budgets` got ordinary column-scoped `INSERT`/`UPDATE`/`DELETE`
(planning metadata, not ledger history — `category_id` and `period` are `INSERT`-only, so a
wrong one is deleted and recreated); `goals` got the CP2 accounts/categories treatment
(soft-delete via `archived_at`, no `DELETE` grant at all); and `goal_contributions` got `INSERT`
only, permanently, because append-only is the entire point of that table. Two `BEFORE INSERT`
guard triggers came with them — `assert_budget_category_active_expense()` and
`assert_goal_contribution_refs()`.

### What Phase 7 CP7 added

`supabase/migrations/20260831120001_bill_writes.sql` — the last two relations, and the one
checkpoint whose *write shape differs per relation for a structural reason*:

| Table | `INSERT` columns | `UPDATE` columns | `DELETE` |
|---|---|---|---|
| `bills` | `id`, `user_id`, `name`, `amount_cents`, `frequency`, `anchor_date`, `category_id`, `account_id` | `name`, `amount_cents`, `frequency`, `anchor_date`, `category_id`, `account_id`, `is_archived` | ❌ ever |
| `bill_occurrences` | ❌ ever | `status`, `transaction_id`, `paid_on` | ❌ ever |

`bill_occurrences` is the only relation in this schema `authenticated` may `UPDATE` without
being able to `INSERT`, and both halves of that are deliberate:

- **No `INSERT`.** An occurrence is a system-derived fact ("this obligation falls due on this
  date, for this amount"), not something a person types. A direct grant would let a hand-crafted
  request invent one on any date for any amount, for a bill whose terms say otherwise — and the
  amount is precisely the value [database-schema.md §13](database-schema.md) protects by copying
  it at generation time.
- **No `DELETE`.** Removing a `scheduled` row is safe; removing a `paid` or `skipped` one
  destroys payment history. PostgreSQL has no column- or predicate-scoped `DELETE`, so a
  table-level grant could not tell the two apart. Only a policy can — and a policy on a role that
  never holds the grant is unreachable.
- **The three columns that *are* granted are exactly the state machine.** `amount_cents` and
  `due_date` are absent, which is the whole point: neither the owner nor the scheduler may
  rewrite what an instance was due for or when.

`bills` gets no `DELETE` either, matching §4's "prefer archive" row — and
`bill_occurrences_bill_fk` is `NO ACTION DEFERRABLE` rather than `CASCADE`, so a hard delete of a
bill with any occurrence would fail at `COMMIT` regardless.

Two new guard triggers. `assert_bill_refs()` (`BEFORE INSERT OR UPDATE`) requires that a named
category not be archived and a named account not be archived, and **each half runs only when its
own column actually changes** — so a bill whose category was archived later can still be renamed,
repriced and unarchived.

**A bill's category `kind` is deliberately unconstrained**, at every layer: the trigger, the
validation schema, the mutation preflight and the form's picker all accept an income category.
No approved pre-CP7 requirement makes a bill's category an expense category — `bills.category_id`
is a plain nullable composite FK with no `CHECK`, and neither this document nor
[database-schema.md](database-schema.md) §4/§13 states a kind rule for it. CP6's budgets rule is
not transferable: for a budget, `expense` is what the row *means*, whereas for a bill the category
is a label on a recurring obligation. And `guard_category_kind_change()` (CP2) naming `bills`
proves only that a *referenced* category's kind becomes immutable, not that the kind must be
`expense`. `180-bill-writes.sql` asserts the acceptance positively, so a later checkpoint cannot
introduce the narrower rule quietly.

`guard_bill_occurrence_transition()` (`BEFORE UPDATE`) is the
four supported transitions, the owner-timezone `paid_on` ceiling, and the row-level restatement
that nothing outside the state machine may move, for *every* role rather than only the one the
grant constrains).

#### The scheduler bridge — one `SECURITY DEFINER`, and how narrow it is

Generating and rebuilding occurrences needs privileges `authenticated` deliberately does not
have, and the recurrence machinery lives in `private`, which `authenticated` has no `USAGE` on
and must never get (§9, and CP4's invoker RPCs depend on it). So CP7 adds exactly one bridge,
built to CP5's rules:

| Function | Security | Parameters | `EXECUTE` |
|---|---|---|---|
| `public.create_bill(uuid, text, bigint, bill_frequency, date, uuid, uuid)` | `INVOKER` | bill id, name, amount, frequency, anchor, category, account | `authenticated` only |
| `public.replace_bill(...)` | `INVOKER` | same | `authenticated` only |
| `public.set_bill_archived(uuid, boolean)` | `INVOKER` | bill id, archive flag | `authenticated` only |
| `public.maintain_bill_schedule(uuid, boolean)` | **`DEFINER`**, owned by `finance_snapshot_writer` | owned bill id, rebuild flag | `authenticated` only |
| `private.generate_bill_occurrences_for_bill(uuid, uuid, date, date)` | `INVOKER` | — | `finance_snapshot_writer` only |

The three bill RPCs are `SECURITY INVOKER` for CP4's reason: the caller already holds every
privilege their bodies use. They exist because a bill and its schedule must commit *together* —
a created bill with no occurrence has no projected due date and is invisible on `/bills`, and an
edited bill whose future schedule failed to rebuild would disagree with its own terms
permanently. PostgREST issues one statement per request in its own transaction, so neither is
expressible as a sequence of PostgREST calls.

`maintain_bill_schedule` is the definer, and it is narrow by construction:

- **No owner parameter.** The owner is read from the request's own JWT claim via
  `private.request_owner_id()`, exactly as CP5's snapshot bridge does, and the bill is then
  scoped `where id = p_bill_id and user_id = <that owner>`.
- **No horizon, no date range, no month.** The rolling horizon — **one year from the owner's own
  calendar day**, widened to the bill's anchor when that anchor is further out — is a constant
  inside the function body that no client can reach. `090-privileges.sql` asserts the argument
  list is exactly `(uuid, boolean)`, the same way it asserts the snapshot bridge takes zero
  arguments: the guarantee is a property of the signature, not of a check inside the body.
- **Owned by the existing `finance_snapshot_writer`** — `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`,
  no application member — never `postgres`, whose `BYPASSRLS` would make a browser-reachable
  function into an RLS bypass. `search_path = ''`, every name qualified. `CREATE ON SCHEMA public`
  is granted for the one `ALTER FUNCTION … OWNER TO` statement and revoked immediately.
- **One new privilege for the role: `DELETE` on `bill_occurrences`**, behind a policy narrower
  than any other writer policy in this schema — `status = 'scheduled' AND user_id =
  private.request_owner_id()`. Paid and skipped history is unreachable at the *policy* layer,
  before Phase 4's `guard_bill_occurrence_delete()` trigger is even consulted, and a session with
  no JWT claim (a psql shell, a cron job) can delete nothing at all.
- **It gains nothing else.** No `UPDATE` on `bill_occurrences` ever — the scheduler may add a
  scheduled occurrence or remove a scheduled occurrence, and may never rewrite one.

**Bill tracking creates no ledger activity.** No function or action in CP7 writes a transaction,
a movement, an account or a budget, and none refreshes the net-worth snapshot — there is no
figure for it to recompute. Marking a bill paid may optionally *reference* one of the owner's
existing transactions, and that reference alters nothing about it;
`bill_occurrences_transaction_fk` (`NO ACTION DEFERRABLE`) then protects the transaction from
deletion until the occurrence is unmarked.

**Deliberate limitation, recorded rather than implied:** Phase 4's
`private.write_net_worth_snapshot` carries **two** sign guards — `v_assets_cents < 0` and
`v_liabilities_cents < 0` — and raises `data_exception` (SQLSTATE 22000) before writing anything
rather than storing either magnitude negative. CP4 and CP5 together make both states reachable
through ordinary supported writes: an owner whose whole *asset* position is negative (one
overdrawn account and no savings), and an owner with an overpaid card and no other debt. In both
cases the application degrades correctly — the refresh is best-effort, so the ledger write still
commits, the action reports success, one sanitized classification is logged, and the existing
snapshot row is left untouched — and CP5 does not alter the Phase 4 writer. See
[database-schema.md §14](database-schema.md) for the full statement.

---

## 4. Operation-specific RLS policies

**A single blanket `FOR ALL TO authenticated` policy is rejected for this schema.** It would
grant a browser session direct write/delete capability to every owned table before those
operations exist in the application — broader than anything the read-only system uses, and a
needless increase in blast radius if a session or a Server Action is ever compromised or buggy.
Every policy here is scoped to one operation.

Combined with §3's grants, this table is the intended eventual policy matrix — most rows are
"not yet," reflecting that write policies are added only alongside their feature:

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `profiles` | own row | ❌ never — provisioning/admin creates it, not the application | Phase 7, **column-scoped to `timezone` only** (see below) | ❌ never |
| `accounts` | own rows | ✅ **CP2** (`accounts_insert_own`) | ✅ **CP2**, incl. archive (`accounts_update_own`) | ❌ prefer archive (`is_archived`) over delete |
| `categories` | own rows | ✅ **CP2** (`categories_insert_own`) | ✅ **CP2**, including archive (`categories_update_own`) | ❌ no routine hard delete while referenced |
| `transactions` | own rows | ✅ **CP3** (`transactions_insert_own`) | ✅ **CP3**, own **ordinary non-adjustment** rows only (`transactions_update_own_ordinary`) | ✅ **CP3**, own **non-movement** rows only (`transactions_delete_own_non_movement`) |
| `movements` | ✅ **CP4** (`movements_select_own`) | ✅ **CP4** (`movements_insert_own`) | ❌ **never** — no grant and no policy; an edit rewrites the pair through `replace_movement` | ✅ **CP4** (`movements_delete_own`) — cascades both legs |
| `budgets` | own rows | Phase 7 | Phase 7 | Phase 7, only if deliberately needed |
| `bills` | own rows | Phase 7 | Phase 7, including archive | ❌ prefer archive |
| `bill_occurrences` | own rows | ❌ — system-generated only | Phase 7, **narrowly scoped to `status`/payment fields only** | ❌ no unrestricted authenticated delete |
| `goals` | own rows | Phase 7 | Phase 7, including archive | ❌ soft-delete (`archived_at`) only |
| `goal_contributions` | own rows | **Phase 7, INSERT only** | ❌ never — append-only, see [database-schema.md §12](database-schema.md#12-goal-contribution-model) | ❌ never |
| `net_worth_snapshots` | own rows | ❌ never | ❌ never | ❌ never — written only by the trusted snapshot mechanism (§9) |

Every SELECT policy uses the ownership predicate from §1. Illustrative shape (not migration-ready):

```sql
CREATE POLICY select_own ON accounts
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
```

### Column-scoped updates are a `GRANT` concern, not an RLS concern

Two rows above name a column restriction — `profiles.timezone` and
`bill_occurrences.status`/payment fields. **RLS filters rows, not columns.** A `FOR UPDATE`
policy that matches `auth.uid() = user_id` still permits updating *every* column on a matched
row, including ones the application never intends to expose. The column restriction must be a
`GRANT UPDATE (timezone) ON profiles TO authenticated`-style column-level grant, applied when
Phase 7 builds that feature. Documenting this now so it isn't mistaken for something the RLS
policy alone will cover.

### CP3: a policy predicate doing more than ownership

`transactions` is the first table where the write policies filter on something other than the
owner, and each extra clause replaces a capability the application must not have:

- **`movement_id IS NULL`**, in the `UPDATE` policy's `USING` *and* `WITH CHECK`, and in the
  `DELETE` policy's `USING`. It is the entire mechanism by which a transfer or card-payment leg
  is unreachable from the ordinary transaction surface: a leg is invisible to both statements, so
  neither can half-rewrite a movement or remove one leg and strand the other. Deleting a movement
  stays a CP4 operation on the *parent* row, which cascades both legs
  (`transactions_movement_fk` is `ON DELETE CASCADE`). It is deliberately absent from the
  `INSERT` policy — a leg has to be insertable for CP4 to exist, and every other guarantee about
  legs is `validate_movement()`'s deferred job.
- **`kind <> 'adjustment'`**, in the `UPDATE` policy's `USING` *and* `WITH CHECK`, refusing two
  different things. `USING` stops an existing adjustment being targeted: it records a
  reconciliation decision, and editing it would restate the balance that decision produced
  without the reconciliation that justified it. `WITH CHECK` stops an ordinary row being *turned
  into* one — without it, the entry surface would be a two-step path (create an expense, retype
  it) to writing the CP5-only row CP3 is not supposed to ship. Adjustment `DELETE` is left
  possible on purpose: reconciliation is delete-and-rewrite.

The `UPDATE`-with-no-error failure mode described below matters most here. An `UPDATE` whose
target fails `USING` raises *nothing* — it simply matches zero rows — so
`supabase/tests/database/110-write-rls.sql` proves each of these by re-reading the row afterwards
rather than by trusting the absence of a throw.

Phase 7 CP2 is the first place column-scoping actually landed — see §3's column tables for
`accounts` and `categories`. Two consequences worth recording, both learned by building it:

- The `UPDATE` policies take **both** `USING` and `WITH CHECK`. `USING` decides which existing
  rows the statement may touch; `WITH CHECK` decides what they may look like afterwards. With
  `USING` alone, an owned row could be updated into a shape no longer satisfying the predicate.
  `user_id` is not in the `UPDATE` grant, so that is already unreachable — but a policy that
  depends on a grant's column list for its own correctness is one edit away from being wrong.
- `has_table_privilege(role, table, 'insert')` is **false** for a role holding only column
  privileges, so a posture test written with it would report "zero write grants" on a
  demonstrably writable table. `has_any_column_privilege()` is the right function, except for
  `DELETE`, which has no column-level form at all and raises "unrecognized privilege type" if
  asked. `supabase/tests/database/100-write-grants.sql` uses each accordingly.

---

## 5. What RLS cannot enforce

RLS filters rows visible to/affected by a query. It does not express relationships, workflow
ordering, or column-level scope. Stated plainly, because a document that implies otherwise would
be actively dangerous to whoever provisions this schema:

- **It cannot enforce that a transaction's `account_id` belongs to the same user as the
  transaction itself.** That's a join-time relationship, not a filterable row property of
  `transactions` alone — enforced instead by the composite foreign key (§6).
- **It cannot enforce the two-leg movement invariant** — "exactly two legs, summing to zero,
  matching kind" spans multiple rows across a transaction boundary. Enforced by the deferred
  constraint trigger (§7).
- **It cannot restrict which columns an otherwise-permitted UPDATE touches** (§4).
- **It cannot substitute for authorization logic that depends on business state** — e.g., "a bill
  occurrence can only move to `paid` if it isn't already `paid`" is workflow, not ownership, and
  belongs in the DAL/Server Action layer in Phase 7.

**RLS protects ownership. Constraints and triggers protect financial integrity. Grants control
which operations are reachable at all.** All three are required; none substitutes for another.

---

## 6. Composite FK role

Detailed in [database-schema.md §3](database-schema.md#3-ownership-model). Restated here because
it is load-bearing for the security story: every parent table declares `UNIQUE (id, user_id)`,
and every child foreign key references that composite —

```
transactions: FOREIGN KEY (account_id, user_id) REFERENCES accounts(id, user_id)
```

This makes cross-table ownership a **structural database fact that holds under direct SQL
access**, independent of RLS being enabled, misconfigured, or bypassed. It is the mechanism that
answers exactly the gap named in §5's first bullet.

---

## 7. Movement trigger role

Full behavioral specification in
[database-schema.md §7](database-schema.md#7-the-movement-invariant-in-detail). In security terms:
the trigger is what makes the two-leg movement invariant survive **direct SQL access** — a client
connecting straight to Postgres (bypassing the application, bypassing RLS's row-filtering
semantics entirely, since a table owner or superuser is not filtered by an ordinary policy) still
cannot leave a movement with one leg, zero legs while the parent exists, or unbalanced legs. This
is why the trigger — not application-level validation in a Server Action — is the design for
Phase 4: application code can be bypassed by anyone with a direct database connection; a
`DEFERRABLE` constraint trigger cannot be, short of disabling triggers outright (a privileged,
auditable operation, not an ordinary write).

---

## 8. FORCE ROW LEVEL SECURITY strategy

**`ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` on all user-owned tables** — the
consistent, intended defense-in-depth posture. `FORCE` matters specifically because without it,
RLS policies do not apply to the table's **owner** (typically the role that ran the migration),
which would otherwise leave an unfiltered path to every row for that role.

**Important correction to an earlier draft of this design:** `FORCE ROW LEVEL SECURITY` does
**not** make a table's data inaccessible to every elevated role. Two things still bypass it
regardless of `FORCE`:

- **PostgreSQL superusers**, and any role with the `BYPASSRLS` attribute, ignore RLS entirely —
  `FORCE` has no effect on them.
- **A `SECURITY DEFINER` function executes with its *owner's* privileges**, not the caller's —
  so a `SECURITY DEFINER` function owned by a role that bypasses RLS bypasses RLS when it runs,
  irrespective of whether `FORCE` is set on the tables it touches.

**This means `FORCE ROW LEVEL SECURITY` is not a reason to exempt `net_worth_snapshots` — or any
table — from the standard posture.** `FORCE` is applied uniformly across all user-owned tables,
including `net_worth_snapshots`. The snapshot writer's need for elevated read access is a
**function-ownership and role-privilege question**, addressed in §9, not a table-level `FORCE`
exception. An earlier version of this document proposed omitting `FORCE` specifically on
`net_worth_snapshots` to work around the writer's needs; that reasoning was incorrect and is
retracted here in favor of the ownership/privilege model in §9.

---

## 9. `SECURITY DEFINER`, `BYPASSRLS`, and the snapshot writer

The monthly net-worth snapshot writer (`docs/database-schema.md §14`) computes each target
month's assets/liabilities from an **as-of query bounded by that month's last calendar day** —
**not** simply today's live `account_balances` view — across every user, and writes the result
into `net_worth_snapshots` for potentially every user, in a `pg_cron` context where
**`auth.uid()` is null** — there is no authenticated session, so no ownership-predicate RLS
policy can match. The writer necessarily needs privilege beyond what any ordinary
`authenticated` row-owner grant provides, to read the underlying `transactions`/`accounts` rows
its as-of calculation needs across every user, and to write into `net_worth_snapshots`, which
`authenticated` never has any grant on at all (§3, §4).

### The trust boundary this creates — stated explicitly, not glossed over

A function with this capability is, by construction, a **trusted execution boundary that reads
and writes across every user's financial data**, whether it runs as a `SECURITY DEFINER` function
owned by a privileged role, or as a role holding `BYPASSRLS` directly. **If the eventual Phase 4
implementation uses a highly-privileged, `postgres`-owned `SECURITY DEFINER` function, that
elevated trust boundary must be acknowledged explicitly in the migration's own documentation, not
treated as an implementation detail.** This is the single most privileged piece of logic in the
schema and should be reviewed as such.

### What is decided now vs. deferred to Phase 4

**Not decided in this phase:** the exact identity and privilege level of the database role that
owns the snapshot-writer function. That is explicitly a **Phase 4 provisioning decision** — it
depends on what Supabase's managed environment actually permits (custom roles, `pg_cron`'s
execution context, whether a narrower non-superuser role can be granted just enough `SELECT`
across `account_balances`/`transactions` without full `BYPASSRLS`). Recorded here as an open
question rather than a premature choice; **the goal for Phase 4 is the least-privileged design
that is practical within Supabase's actual constraints**, verified against the real environment
rather than assumed from this document.

**Decided now — hardening requirements the eventual implementation must satisfy, regardless of
which role is chosen:**

- **Fixed, safe `search_path`** set explicitly on the function definition — the standard
  `SECURITY DEFINER` privilege-escalation vector (an unset or attacker-influenced `search_path`
  can redirect unqualified references to attacker-controlled objects).
- **Fully-qualified table and function references** inside the function body where practical, so
  name resolution cannot be redirected even if `search_path` handling has a gap.
- **Minimal `EXECUTE` grants** — revoked from `PUBLIC`; not callable by `anon` or `authenticated`
  (see §11).
- **Explicit in-function user scoping** — the function iterates over users or is otherwise
  parameterized per-user; it must not perform an unscoped cross-user write path by accident.
- **Never relies on `auth.uid()`** — cron has no authenticated user context, and any logic
  assuming otherwise either silently no-ops or writes against the wrong row.
- **Verified against the actual Supabase/Postgres environment during Phase 4 provisioning** —
  this document states requirements; it does not assume Supabase's managed `pg_cron` offering
  behaves identically to vanilla Postgres, and that gap must be checked before relying on it.

**Resolved in Phase 7 CP8A.** The role is `finance_snapshot_writer` (decided in Phase 4, unchanged
since), and `pg_cron` is now actually scheduled — two daily jobs, each a single call to a
`SECURITY DEFINER` function owned by that role, satisfying every requirement above: fixed
`search_path`, qualified references, `EXECUTE` revoked from `PUBLIC`/`anon`/`authenticated`,
explicit per-owner iteration (never an unscoped cross-user write), and no reliance on `auth.uid()`
— the functions use `private.request_owner_id()`'s own GUC, impersonated one owner at a time via
`set_config`, exactly as CP5's request-scoped bridge already does for a live request. Full design
in [database-schema.md](database-schema.md#phase-7-cp8a--pg_cron-is-finally-scheduled-and-it-is-the-writer-this-section-always-intended).
Verified against the real local Postgres/pg_cron image, not assumed — `postgres` is `NOSUPERUSER`
here exactly as this document already notes, which is why the scheduled command is a `SECURITY
DEFINER` call rather than pg_cron running the job directly as `finance_snapshot_writer` (that path
requires an actual superuser to schedule).

---

## 10. `security_invoker` views

An ordinary PostgreSQL view executes with the **view owner's** privileges by default — this
silently bypasses RLS on the underlying tables regardless of how carefully those tables' policies
are written, because the view itself is the thing actually running the query.

> **Every view that exposes user-owned data and relies on underlying RLS must be explicitly
> reviewed for execution security and declared `WITH (security_invoker = on)`. Never assume a
> view inherits RLS safely by default.**

Applies to every planned view in this schema:

- `account_balances` ([database-schema.md §11](database-schema.md#11-derived-account-balances))
- the goal saved-balance rollup ([database-schema.md §12](database-schema.md#12-goal-contribution-model))
- the bill next-unpaid-occurrence projection, **if** implemented as a view rather than in the DAL
  ([database-schema.md §13](database-schema.md#13-recurring-bill--occurrence-model))

Any future view added to this schema inherits the same requirement by default — it is a schema-
wide policy, not a per-view judgment call.

---

## 11. EXECUTE privilege rules for functions

Every function/RPC in this schema — the timezone-validation trigger function
([database-schema.md §10](database-schema.md#10-date-and-timezone-rules)), the movement
constraint-trigger function ([database-schema.md §7](database-schema.md#7-the-movement-invariant-in-detail)),
the bill-occurrence deletion-guard trigger function
([database-schema.md §13](database-schema.md#13-recurring-bill--occurrence-model)), the Phase 7
write guards (`accounts_guard_update()`, `guard_category_kind_change()`,
`assert_transaction_refs()` — [database-schema.md §6](database-schema.md#6-constraints-and-cross-row-invariants)),
and the snapshot writer (§9) — follows the same rule:

**`EXECUTE` is revoked from `PUBLIC` by default. A function is callable by `anon` or
`authenticated` only when that access is intentional and explicitly granted for a stated
application reason.**

### Trigger execution context — corrected

An earlier draft of this document justified skipping direct `EXECUTE` grants on the trigger
functions by claiming "triggers fire under the table owner's context." **That is not how
PostgreSQL trigger execution works, and the claim is retracted:**

- **By default, a trigger function executes as the role that performed the triggering
  `INSERT`/`UPDATE`/`DELETE`** — i.e., as `authenticated`, for an ordinary application write once
  writes exist (Phase 7), not as the table owner.
- **A trigger function executes as its owner only if it is itself declared `SECURITY DEFINER`.**
  Whether the timezone-validation trigger, the movement-invariant trigger, and the
  bill-occurrence deletion-guard trigger need `SECURITY DEFINER` is **not decided in this
  phase** — it is a Phase 4 implementation choice for each trigger individually, based on what
  privilege that specific check actually needs beyond what `authenticated`'s own row-level access
  already provides. **Do not assume every trigger in this schema is `SECURITY DEFINER` by
  default** — most likely do not need to be, since they validate against catalog data
  (`pg_timezone_names`) or rows the triggering role already has SELECT access to.
- **If** a given trigger function is made `SECURITY DEFINER` in Phase 4, it must satisfy the same
  hardening already specified for the snapshot writer (§9): a fixed, safe `search_path`,
  fully-qualified references where appropriate, minimal privileges, and no unnecessary direct
  `EXECUTE` exposure.

**How it actually turned out: every trigger function in this schema is `SECURITY INVOKER`,
including the three Phase 7 write guards.** That is not an oversight and it is asserted, not
assumed — `supabase/tests/database/000-objects.sql` checks `prosecdef = false` on each of them.
The reasoning is the same in every case and is worth stating once: each guard reads rows the
triggering role already has `SELECT` on, and under `FORCE ROW LEVEL SECURITY` the invoker sees
exactly its own — which is precisely the scope the check wants. `assert_transaction_refs()` is
the sharpest example: it looks up the owner's profile, the account, and the category, and every
one of those lookups *should* be limited to the caller's own rows. Taking a definer's privileges
would hand a browser-reachable write path capabilities it has no use for, in exchange for
nothing.

**The correct reason `EXECUTE` on these trigger functions doesn't need a direct grant to
`authenticated`** is unrelated to execution context: PostgreSQL invokes a trigger function
automatically as part of the triggering DML statement — there is no separate `EXECUTE`-privilege
check for the calling role to invoke a trigger the way there would be for calling a
free-standing function/RPC directly. `EXECUTE` still stays revoked from `PUBLIC` on the function
itself, consistent with every other function in this schema — that default simply isn't what
makes trigger invocation work.

The snapshot writer needs no `authenticated` or `anon` `EXECUTE` grant under the `pg_cron`
design; if the documented on-demand fallback (`database-schema.md §14`) is ever exposed as a
callable RPC instead, that is a **separate, deliberate grant decision** to make explicitly at
that time — not a default extension of the cron writer's existing privilege.

### The eight RPCs — the only `EXECUTE` grants to an application role

`public.create_movement` and `public.replace_movement` (CP4); `public.reconcile_account` and
`public.refresh_current_net_worth_snapshot` (CP5); and `public.create_bill`,
`public.replace_bill`, `public.set_bill_archived` and `public.maintain_bill_schedule` (CP7) are
the only functions `authenticated` may call directly. That is the "intentional and explicitly granted for
a stated application reason" case the rule above anticipates, and the reason is structural
rather than ergonomic: a valid movement cannot be assembled by any sequence of PostgREST
statements (§3), so a function is the only thing that can write one.

Three properties make that grant narrow rather than a widening:

- **`SECURITY INVOKER`, despite doing an atomic multi-table write.** That is the shape people
  normally reach for `SECURITY DEFINER` to implement, and it is not needed here: the caller
  already holds every privilege the bodies use (`SELECT` on `accounts` and `movements`, the
  column-scoped `INSERT`s, `DELETE` on `movements`), and under `FORCE ROW LEVEL SECURITY` the
  invoker sees exactly its own accounts and movements — which is precisely the scope every
  lookup wants. A definer's context would not add a check; it would remove the RLS backing
  every statement inside. `090-privileges.sql` asserts `prosecdef = false` on both.
- **No owner parameter.** Neither function takes a `user_id`. A caller-supplied owner is an
  authorization decision made by untrusted input, and no amount of policy work downstream
  repairs it. `auth.uid()` is read inside each body, and a null one raises.
- **`EXECUTE` revoked from `PUBLIC` and `anon`, granted to `authenticated` alone.** An
  unauthenticated request is `anon`, so "an anonymous request cannot create a movement" is a
  privilege-layer fact rather than something the function body has to notice —
  `100-write-grants.sql` proves it by actually calling both as `anon` and asserting 42501.
  `090-privileges.sql` additionally asserts that these are the *entire* set of `public`-schema
  functions `authenticated` may execute, as a sorted list rather than a count.

Six of the eight are `SECURITY INVOKER`, for the reasons above.
`refresh_current_net_worth_snapshot` (CP5) and `maintain_bill_schedule` (CP7) are the only two
`SECURITY DEFINER` exceptions in the whole application, and in both cases the reason is a hard
boundary rather than a preference: the machinery each one reaches lives in `private`, is owned by
`finance_snapshot_writer`, and writes a relation `authenticated` holds no write grant on. See §3,
*What Phase 7 CP5 added* and *What Phase 7 CP7 added*, for why an invoker wrapper could reach
nothing either one needs, and for the properties that keep both definers' identity narrow: a
`NOLOGIN`/`NOBYPASSRLS` owner, no owner parameter (both read the request's own JWT claim), no
addressable month/horizon/range, no standing `CREATE` on `public`, and — for the scheduler — a
`DELETE` policy restricted to `status = 'scheduled'` and the calling request's own rows.
`090-privileges.sql` pins each one's argument list exactly: zero parameters for the snapshot
bridge, `(uuid, boolean)` for the scheduler.

---

## 12. No `service_role` in application code

`service_role` bypasses RLS entirely by design — it exists for trusted server-side/administrative
operations, not for anything the Next.js application itself runs. **`service_role` never appears
in application code, in any phase of this roadmap.** Application authorization always runs as
the authenticated user's own session, subject to the grants and policies documented here. See
[auth-design.md](auth-design.md) for how that session is established and verified.

---

## 13. What Phase 8 added

Two migrations, one new table, one widened column grant, and two new `SECURITY INVOKER` functions.
**No `SECURITY DEFINER` function was added, no existing policy was rewritten, and neither
`finance_snapshot_writer` nor `anon` gained a single privilege.**

### 13.1 `monthly_plans` â€” the budgets shape, transplanted

`20260902120002_monthly_plans.sql`. RLS `ENABLE` + `FORCE`, four operation-specific policies each
targeted at `authenticated` and predicated on `(select auth.uid()) = user_id`, and column-scoped
grants:

| Operation | Columns | Why |
| --- | --- | --- |
| `SELECT` | table | The one read path, `getMonthlyPlan(period)` |
| `INSERT` | `id, user_id, period, expected_income_cents` | `id` for the client-minted idempotency key; `user_id` so the row is insertable at all |
| `UPDATE` | `expected_income_cents` | The only thing about an existing plan a person can change |
| `DELETE` | table | Planning metadata, no history to lose â€” and "not set" is a state a zero cannot express |

`period` is **INSERT-only**, exactly as `budgets.period` is and for the identical reason: it
decides which month the row *is*, and getting the month wrong means writing that month's own row
rather than relabelling this one. `100-write-grants.sql` asserts the column matrix and
`210-monthly-plans.sql` asserts the behaviour, including that owner A's update and delete against
owner B's plan match zero rows and leave it untouched.

`anon` is named in no grant and no policy. `finance_snapshot_writer` holds **nothing** on this
table, which is what makes "an expected figure cannot reach net worth" structural rather than a
rule the snapshot writer happens to follow â€” `090-privileges.sql` proves the writer's `SELECT` is
refused with 42501.

No trigger. There is nothing cross-row to assert: the table references no category, account or
transaction, its format and sign rules are plain `CHECK`s, and its month is chosen by the server
from the owner's own `profiles.timezone` rather than accepted from a client.

### 13.2 `bill_occurrences.transaction_origin` â€” one column, and why it can be granted

`20260902120001_bill_payment_ledger.sql` widens CP7's three-column UPDATE grant to four:

```sql
grant update (transaction_origin) on table public.bill_occurrences to authenticated;
```

`amount_cents` and `due_date` are still absent, which is the part of CP7 that has not moved and
must not: they are what *this* instance was due for and when, fixed at generation time. There is
still no `INSERT` and no `DELETE` on this table for `authenticated`, ever.

The new column *has* to be grantable, because `public.settle_bill_occurrence` is `SECURITY
INVOKER` and therefore writes as the caller. What prevents a hand-crafted request from claiming
`'generated'` over a hand-written transaction â€” and then having it deleted by unmarking â€” is
**not** the grant but `guard_bill_occurrence_transition()`:

```sql
-- accepted only when the referenced transaction was created by THIS transaction
if v_created_at is not null and v_created_at <> now() then raise ... end if;
```

`now()` is `transaction_timestamp()` and `transactions.created_at` takes the identical default, so
the equality holds only for a row inserted by the very transaction performing the update. It is
unforgeable because `authenticated` holds no grant on `transactions.created_at` on `INSERT` *or*
`UPDATE` â€” there is no statement available to that role that could manufacture a qualifying row.
`200-bill-payment-ledger.sql` proves both halves: the forged label is refused with 23514, and the
same statement with `'linked'` succeeds.

This is the pattern Â§5 describes ("what RLS cannot enforce") used in its strongest form so far: a
privilege that must be held is made safe by a row-level invariant the privilege holder cannot
satisfy dishonestly.

### 13.3 `settle_bill_occurrence` / `unsettle_bill_occurrence`

Both `SECURITY INVOKER`, `search_path = ''`, owner from `auth.uid()`, `EXECUTE` revoked from
`PUBLIC`/`anon` and granted to `authenticated` alone. They bring the count of functions
`authenticated` may execute anywhere in `public` from eight to ten, and `090-privileges.sql`
asserts that sorted list exactly.

They are `INVOKER` for the CP4/CP7 reason, and it matters more here than anywhere else because
they write the **ledger**: the caller already holds `INSERT` and `DELETE` on `transactions` and the
four-column `UPDATE` on `bill_occurrences`, and under FORCE RLS the invoker sees only its own rows.
A definer's context would strip RLS off a browser-reachable path that creates and removes
expenses â€” the one place in this schema where that would be least acceptable.

Their *signatures* carry a security property of their own, asserted in `090-privileges.sql` the way
`maintain_bill_schedule`'s is: `(uuid, date, uuid, uuid)` and `(uuid)`. No owner, no account, no
category, no merchant, no amount, no kind. Every fact about the row they may write is read from the
occurrence and its bill, so a hand-crafted request cannot post an expense of its choosing through
the bill surface.

The reversal's `DELETE` is likewise not a new privilege: it runs under CP3's existing
`transactions_delete_own_non_movement` policy, scoped to the caller's own non-movement rows. A
generated payment is an ordinary row and is reachable; nothing else is.
