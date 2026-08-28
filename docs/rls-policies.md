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
| `authenticated` | `SELECT` on the tables/views the application actually reads, plus **column-scoped** `INSERT`/`UPDATE` on `accounts` and `categories` only. | accounts, categories | accounts, categories | ❌ **nothing, anywhere** |

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

Functions/RPCs (the snapshot writer, the timezone-validation trigger function) get `EXECUTE`
revoked from `PUBLIC` by default — see §11.

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
| `transactions` | own rows | Phase 7 | Phase 7 | Phase 7, non-movement rows only |
| `movements` | own rows | Phase 7 | ❌ never | Phase 7 — cascades both legs |
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

Phase 7 CP2 is the first place this actually landed — see §3's column tables for `accounts` and
`categories`. Two consequences worth recording, both learned by building it:

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
([database-schema.md §13](database-schema.md#13-recurring-bill--occurrence-model)), and the
snapshot writer (§9) — follows the same rule:

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

---

## 12. No `service_role` in application code

`service_role` bypasses RLS entirely by design — it exists for trusted server-side/administrative
operations, not for anything the Next.js application itself runs. **`service_role` never appears
in application code, in any phase of this roadmap.** Application authorization always runs as
the authenticated user's own session, subject to the grants and policies documented here. See
[auth-design.md](auth-design.md) for how that session is established and verified.
