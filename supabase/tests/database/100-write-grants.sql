-- Write-privilege posture: the exact CP7 matrix, and nothing wider.
--
-- Phase 7 CP1 shipped no migration and no write GRANT at all, and this
-- file proved it. CP2 opened two tables -- accounts and categories --
-- so the file became an allowlist rather than an emptiness check. CP3
-- added a third, transactions, and with it the first DELETE grant in
-- this schema. CP4 added a fourth, movements. CP6 adds three more --
-- budgets, goals, goal_contributions. The purpose is unchanged and, if
-- anything, sharper: the set of things `authenticated` can write is a
-- checked fact, down to the column and down to the operation, so
-- neither a later checkpoint nor a careless migration can widen it
-- without a test turning red here.
--
-- INSERT: accounts, categories, transactions, movements, budgets,
-- goals, goal_contributions -- column-scoped in every case. UPDATE: all
-- of those except movements and goal_contributions. DELETE:
-- transactions, movements and budgets only. The sets are deliberately
-- different, and each difference carries a reason:
--
--   * Accounts, categories, bills and goals are *labels* historical rows
--     resolve through, so they are archived rather than removed. A
--     transaction is the history itself and has no correct archived
--     state; a movement is the only correct unit for removing a pair of
--     legs, since deleting the parent cascades both and a leg is
--     invisible to DELETE outright. A budget is planning metadata, not
--     ledger history, so it alone among the archived-style tables gets
--     an ordinary hard DELETE -- there is nothing about it worth
--     preserving once it is wrong.
--   * movements holds no UPDATE at all. Its row is (id, user_id, kind),
--     and changing `kind` in place would contradict every leg's own kind
--     -- an edit rewrites the pair through public.replace_movement, it
--     does not retype the parent.
--   * goal_contributions holds no UPDATE and no DELETE, ever --
--     append-only is the entire point of the table
--     (docs/database-schema.md §12). A correction is a new signed row.
--
-- CP4 also brought the first two functions `authenticated` may EXECUTE
-- anywhere in this schema. Their full behavior is 140-movement-writes.sql;
-- what is asserted here is that `anon` cannot reach either one. CP6's
-- full budget/goal/contribution behavior (idempotency, the category and
-- archived-goal guard triggers, cross-owner refusal) is
-- 170-budget-goal-writes.sql; this file stays scoped to the grant
-- matrix.
--
-- Three layers, all asserted, because no one of them is sufficient:
--
--   * Table-level catalog. `has_any_column_privilege()` over every
--     user-financial table for both application roles. This is the
--     exhaustive half -- it cannot miss a table -- and the final
--     assertion proves the table list itself is complete, so a table
--     added by a later migration cannot escape by not being named.
--
--     `has_any_column_privilege()` rather than `has_table_privilege()`,
--     and that distinction is the whole point of this file after CP2:
--     the new grants are COLUMN-scoped, and `has_table_privilege(...,
--     'insert')` is *false* for a role holding only column privileges.
--     Using it here would report "zero write grants" on a table that is
--     demonstrably writable -- a check that passes for the wrong reason
--     is worse than no check.
--
--     DELETE is the exception and stays on `has_table_privilege()`:
--     PostgreSQL has no column-level DELETE privilege at all (only
--     SELECT, INSERT, UPDATE and REFERENCES can be column-scoped), so
--     `has_any_column_privilege(..., 'delete')` is not merely
--     unnecessary -- it raises "unrecognized privilege type".
--
--   * Column-level catalog. For each writable table, the exact set of
--     columns `authenticated` may INSERT and UPDATE, compared as a
--     sorted array against the intended list -- including movements,
--     whose UPDATE set must be empty (a NULL string_agg). A column
--     added to a grant fails this; a column added to the *table* and
--     quietly picked up by a widened grant fails it too.
--
--   * Behavioral. Real statements executed as `authenticated` (with a
--     verified-claim uid set, exactly as PostgREST does) and as `anon`,
--     asserted to fail with 42501. A catalog inspection alone would not
--     notice a write reaching a table by some other route; a statement
--     that actually runs would.
--
-- 42501 is insufficient_privilege: the GRANT layer refuses the
-- operation before RLS is ever consulted. That distinction matters --
-- a missing *policy* on a granted table returns zero rows rather than
-- an error, so a grant-layer denial is the stronger of the two.
--
-- Row-level behavior for accounts/categories/transactions (own vs.
-- foreign rows, user_id reassignment, anon) is 110-write-rls.sql, and
-- for movements it is 140-movement-writes.sql; the invariant triggers
-- are 120/130 and the movement invariant is 020.
--
-- Phase 8 CP1 widens exactly one existing grant and adds no table:
--
--   * bill_occurrences.transaction_origin joins its three-column UPDATE grant.
--     It has to: public.settle_bill_occurrence is SECURITY INVOKER and writes
--     as the caller. What stops a hand-crafted request from claiming
--     'generated' over a hand-written transaction is not the grant but
--     guard_bill_occurrence_transition()'s provenance rule -- see
--     200-bill-payment-ledger.sql, which proves it.
--
-- `amount_cents` and `due_date` are still absent from that grant, which is the
-- part of CP7 that has not moved and must not.
begin;
select plan(104);

-- Every user-financial table. The last assertion in this file proves
-- this list is exactly `public`'s table set, so it cannot silently fall
-- behind a migration.
create temporary table write_posture_tables (name text primary key) on commit drop;
insert into write_posture_tables (name) values
  ('profiles'), ('accounts'), ('categories'), ('movements'), ('transactions'),
  ('budgets'), ('bills'), ('bill_occurrences'), ('goals'), ('goal_contributions'),
  ('net_worth_snapshots');

-- The tables that hold any INSERT grant, kept as a separate list so
-- every assertion below reads as "these and no others" rather than as a
-- hardcoded name repeated in a dozen places.
create temporary table writable_tables (name text primary key) on commit drop;
insert into writable_tables (name) values
  ('accounts'), ('categories'), ('transactions'), ('movements'),
  ('budgets'), ('goals'), ('goal_contributions'), ('bills');

-- bill_occurrences is deliberately NOT in the list above. It is the one
-- relation `authenticated` may UPDATE without being able to INSERT: an
-- occurrence is generated by the scheduler, never entered, so the only
-- thing a person may do to one is change its status. Tracked on its own
-- so "bill_occurrences is writable" can never be true enough to hide
-- which verb.
create temporary table update_only_tables (name text primary key) on commit drop;
insert into update_only_tables (name) values ('bill_occurrences');

-- UPDATE is tracked separately because CP4 and CP6 made the two sets
-- diverge: movements and goal_contributions hold INSERT (and, for
-- movements, DELETE) but **never** UPDATE. A movements row is
-- (id, user_id, kind), and changing `kind` in place would contradict
-- every leg's own kind (validate_movement() assert 3) -- rewriting the
-- pair together is what public.replace_movement does, by
-- delete-and-recreate. goal_contributions has no UPDATE for a different
-- reason: append-only is the entire point of the table. Without its own
-- list, "movements/goal_contributions are writable" would be true
-- enough to hide the one operation that must stay shut on each.
create temporary table updatable_tables (name text primary key) on commit drop;
insert into updatable_tables (name) values
  ('accounts'), ('categories'), ('transactions'), ('budgets'), ('goals'),
  ('bills'), ('bill_occurrences');

-- DELETE is tracked separately too, because it is granted on a strictly
-- narrower set than INSERT: transactions, movements and budgets only.
-- Folding it into the list above would make "accounts cannot be
-- deleted" untestable. goals is deliberately absent -- CP6 gave it the
-- CP2 accounts/categories treatment (soft-delete via `archived_at`),
-- never a DELETE grant.
create temporary table deletable_tables (name text primary key) on commit drop;
insert into deletable_tables (name) values
  ('transactions'), ('movements'), ('budgets');

-- The behavioral section below reads these lists while running *as*
-- `authenticated`/`anon`, so those roles need to see them. Scoped to
-- transaction-local temporary tables that are dropped at commit and
-- rolled back regardless: a test-harness concern only, granting nothing
-- on any application object.
grant select on write_posture_tables, writable_tables, updatable_tables, deletable_tables,
  update_only_tables
  to authenticated, anon;

-- ============================================================
-- Table-level catalog: anon still has zero write grants anywhere
-- ============================================================
-- Unchanged by CP2 -- the migration does not name `anon` in a single
-- GRANT or policy.

select is(
  (select count(*)::int from write_posture_tables t
   where has_any_column_privilege('anon', 'public.' || t.name, 'insert')),
  0,
  'anon has zero INSERT grants (any column) across every user-financial table'
);
select is(
  (select count(*)::int from write_posture_tables t
   where has_any_column_privilege('anon', 'public.' || t.name, 'update')),
  0,
  'anon has zero UPDATE grants (any column) across every user-financial table'
);
select is(
  (select count(*)::int from write_posture_tables t
   where has_table_privilege('anon', 'public.' || t.name, 'delete')),
  0,
  'anon has zero DELETE grants across every user-financial table'
);

-- ============================================================
-- Table-level catalog: authenticated writes exactly four tables
-- ============================================================

select is(
  (select count(*)::int from write_posture_tables t
   where has_any_column_privilege('authenticated', 'public.' || t.name, 'insert')
     and t.name not in (select name from writable_tables)),
  0,
  'authenticated has no INSERT grant outside accounts/categories/transactions/movements/budgets/goals/goal_contributions/bills'
);
select is(
  (select count(*)::int from writable_tables t
   where has_any_column_privilege('authenticated', 'public.' || t.name, 'insert')),
  8,
  'authenticated does hold an INSERT grant on all eight insertable tables (not vacuous)'
);

-- The single most important negative fact about the CP7 grants, stated on
-- its own because a set-difference assertion is easy to read past: an
-- occurrence is *generated*, never entered. `authenticated` may change a
-- status but may not invent an obligation on any date, for any amount,
-- for a bill whose terms say otherwise.
select ok(
  not has_any_column_privilege('authenticated', 'public.bill_occurrences', 'insert'),
  'authenticated holds no INSERT privilege on any column of bill_occurrences'
);

-- UPDATE is checked against `updatable_tables`, which is a strict subset
-- of `writable_tables`: this is the assertion that would fail the moment
-- someone "completed" the movements or goal_contributions grants by
-- adding UPDATE.
select is(
  (select count(*)::int from write_posture_tables t
   where has_any_column_privilege('authenticated', 'public.' || t.name, 'update')
     and t.name not in (select name from updatable_tables)),
  0,
  'authenticated has no UPDATE grant outside accounts/categories/transactions/budgets/goals/bills/bill_occurrences -- movements and goal_contributions included'
);
select is(
  (select count(*)::int from updatable_tables t
   where has_any_column_privilege('authenticated', 'public.' || t.name, 'update')),
  7,
  'authenticated does hold an UPDATE grant on all seven updatable tables (not vacuous)'
);
-- Stated on its own as well, because it is the single most important
-- negative fact about the CP4/CP6 grants and a set-difference assertion
-- is easy to read past.
select ok(
  not has_any_column_privilege('authenticated', 'public.movements', 'update'),
  'authenticated holds no UPDATE privilege on any column of movements'
);
select ok(
  not has_any_column_privilege('authenticated', 'public.goal_contributions', 'update'),
  'authenticated holds no UPDATE privilege on any column of goal_contributions -- append-only'
);

-- DELETE is table-level only -- PostgreSQL has no column-level DELETE
-- privilege at all, so `has_any_column_privilege(..., 'delete')` does
-- not merely fail to help, it raises "unrecognized privilege type".
select is(
  (select count(*)::int from write_posture_tables t
   where has_table_privilege('authenticated', 'public.' || t.name, 'delete')
     and t.name not in (select name from deletable_tables)),
  0,
  'authenticated has no DELETE grant outside transactions/movements/budgets -- accounts, categories, goals, goal_contributions, bills and bill_occurrences included'
);
-- Stated on its own for the two CP7 relations, because "no DELETE" means
-- something different on each. A bill is soft-deleted (`is_archived`) so
-- its occurrences survive; an occurrence is never deleted by the
-- application at all, since a paid or skipped one is history and a
-- table-level DELETE grant could not tell it from a scheduled one.
select ok(
  not has_table_privilege('authenticated', 'public.bills', 'delete')
  and not has_table_privilege('authenticated', 'public.bill_occurrences', 'delete'),
  'authenticated holds no DELETE on bills or bill_occurrences -- soft delete and status changes only'
);
select is(
  (select count(*)::int from deletable_tables t
   where has_table_privilege('authenticated', 'public.' || t.name, 'delete')),
  3,
  'authenticated does hold DELETE on transactions, movements and budgets (not vacuous)'
);

-- ============================================================
-- Column-level catalog: the exact CP2/CP3/CP4 column matrix
-- ============================================================
-- Compared as sorted arrays rather than as counts: a count would pass
-- if one column were swapped for another, and "user_id became
-- updatable while name stopped being" is precisely the mistake worth
-- catching.

select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.accounts'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'insert')),
  'credit_limit_cents,institution,interest_rate_bps,name,opening_balance_cents,type,user_id',
  'authenticated may INSERT exactly the 7 intended accounts columns (id/created_at/is_archived excluded)'
);

select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.accounts'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update')),
  'credit_limit_cents,institution,interest_rate_bps,is_archived,name,opening_balance_cents',
  'authenticated may UPDATE exactly the 6 intended accounts columns (id/user_id/type/created_at excluded)'
);

select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.categories'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'insert')),
  'kind,name,user_id',
  'authenticated may INSERT exactly the 3 intended categories columns (id/is_archived excluded)'
);

-- transactions. `id` IS grantable here and nowhere else in this schema:
-- ordinary transaction creation is the one operation where a double
-- submit produces a real duplicate, so the create form supplies a
-- client-generated UUID as the row's id and a retry collides with
-- itself on the primary key. `movement_id` is grantable for CP4's legs
-- and confers nothing today (no INSERT grant exists on public.movements
-- to create a parent to point at). `created_at` is excluded: it is the
-- `date DESC, created_at DESC, id ASC` ordering's tie-break, and a
-- backdatable entry order would silently reorder same-day history.
select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.transactions'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'insert')),
  'account_id,amount_cents,category_id,date,id,kind,merchant,movement_id,user_id',
  'authenticated may INSERT exactly the 9 intended transactions columns (created_at excluded)'
);

-- The UPDATE list is what stands between "correct the amount on my
-- coffee" and "re-home this row", "adopt it into a movement", or "edit
-- away the idempotency collision".
select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.transactions'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update')),
  'account_id,amount_cents,category_id,date,kind,merchant',
  'authenticated may UPDATE exactly the 6 intended transactions columns (id/user_id/movement_id/created_at excluded)'
);

select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.categories'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update')),
  'is_archived,kind,name',
  'authenticated may UPDATE exactly the 3 intended categories columns (id/user_id excluded)'
);

-- movements. `id` is grantable for two reasons: movement creation is
-- idempotent by a client-generated UUID (a retry collides with itself
-- rather than writing a second transfer), and replace_movement
-- re-creates the movement under its *original* id, so a movement id is
-- stable for the movement's whole life. `created_at` is excluded like
-- everywhere else -- it takes its default.
select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.movements'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'insert')),
  'id,kind,user_id',
  'authenticated may INSERT exactly the 3 intended movements columns (created_at excluded)'
);

-- And no UPDATE column at all: `string_agg` over an empty set is NULL,
-- which is the assertion. This is the column-level statement of the
-- table-level fact above.
select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.movements'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update')),
  null,
  'authenticated may UPDATE no movements column whatsoever'
);

-- budgets. Every column the table has (id, user_id, category_id,
-- period, limit_cents) is INSERT-grantable -- there is no created_at on
-- this table and nothing else to exclude, unlike every other table
-- here. `category_id` and `period` decide what the budget fundamentally
-- *is* and are INSERT-only; only `limit_cents` survives into the UPDATE
-- grant below.
select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.budgets'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'insert')),
  'category_id,id,limit_cents,period,user_id',
  'authenticated may INSERT exactly all 5 budgets columns (the table has no others)'
);
select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.budgets'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update')),
  'limit_cents',
  'authenticated may UPDATE only budgets.limit_cents (id/user_id/category_id/period excluded)'
);

-- goals. `archived_at` is UPDATE-only, exactly like accounts.is_archived
-- -- a goal may never be *created* already archived. `id`/`user_id` are
-- INSERT-only, as everywhere else in this schema.
select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.goals'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'insert')),
  'id,name,target_cents,target_date,user_id',
  'authenticated may INSERT exactly the 5 intended goals columns (archived_at excluded)'
);
select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.goals'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update')),
  'archived_at,name,target_cents,target_date',
  'authenticated may UPDATE exactly the 4 intended goals columns (id/user_id excluded)'
);

-- goal_contributions. `id` is grantable for the same client-minted-key
-- reason as transactions.id and movements.id: two identical real
-- contributions are legitimate distinct events, so only a stable key can
-- tell a retry apart from a second one. `created_at` is excluded, like
-- everywhere else it exists -- it takes its default. No UPDATE column at
-- all: `string_agg` over an empty set is NULL, the column-level
-- statement of "append-only" above.
select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.goal_contributions'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'insert')),
  'amount_cents,goal_id,id,note,occurred_on,user_id',
  'authenticated may INSERT exactly the 6 intended goal_contributions columns (created_at excluded)'
);
select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.goal_contributions'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update')),
  null,
  'authenticated may UPDATE no goal_contributions column whatsoever'
);

-- bills. Every column but `id`/`user_id`/`created_at`/`is_archived` is
-- both insertable and updatable -- a bill's recurrence terms describe an
-- ongoing arrangement and those genuinely change, unlike a budget's
-- category and month. `id` is grantable for the client-minted
-- idempotency key; `is_archived` is UPDATE-only, exactly like
-- accounts.is_archived and goals.archived_at, so a bill may never be
-- *created* already archived.
select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.bills'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'insert')),
  'account_id,amount_cents,anchor_date,category_id,frequency,id,name,user_id',
  'authenticated may INSERT exactly the 8 intended bills columns (is_archived/created_at excluded)'
);
select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.bills'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update')),
  'account_id,amount_cents,anchor_date,category_id,frequency,is_archived,name',
  'authenticated may UPDATE exactly the 7 intended bills columns (id/user_id/created_at excluded)'
);

-- bill_occurrences. Still the only UPDATE-without-INSERT grant in this
-- schema. `amount_cents` and `due_date` are absent and that is the whole
-- point: they are the historical facts docs/database-schema.md 13
-- protects -- what this instance was due for, and when -- and neither the
-- owner nor the scheduler may rewrite them. `string_agg` over an empty
-- set is NULL, which is the INSERT assertion.
--
-- Phase 8 CP1 adds `transaction_origin` to the UPDATE list, and only
-- that. It has to be there because public.settle_bill_occurrence is
-- SECURITY INVOKER and therefore writes as the caller. Forgery is
-- prevented by guard_bill_occurrence_transition(), not by withholding
-- the column -- see 200-bill-payment-ledger.sql.
select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.bill_occurrences'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'insert')),
  null,
  'authenticated may INSERT no bill_occurrences column whatsoever -- occurrences are generated'
);
select is(
  (select string_agg(a.attname::text, ',' order by a.attname)
   from pg_attribute a
   where a.attrelid = 'public.bill_occurrences'::regclass
     and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'update')),
  'paid_on,status,transaction_id,transaction_origin',
  'authenticated may UPDATE exactly the 4 state-machine columns of bill_occurrences'
);

-- ============================================================
-- The two security_invoker views stay entirely read-only
-- ============================================================
-- Separately grantable objects; a write grant on one would be as real
-- as a write grant on a table. `account_balances` is the read path for
-- accounts, so this is not hypothetical after CP2.

select is(
  (select count(*)::int from (values ('account_balances'), ('goal_balances')) as v(name)
   cross join (values ('anon'), ('authenticated')) as r(role)
   where has_any_column_privilege(r.role, 'public.' || v.name, 'insert')
      or has_any_column_privilege(r.role, 'public.' || v.name, 'update')
      or has_table_privilege(r.role, 'public.' || v.name, 'delete')),
  0,
  'neither application role has any write grant on account_balances or goal_balances'
);

-- Guard against a vacuous pass: a role name that granted nothing
-- anywhere would make several counts above trivially zero. The Phase 6
-- read grants must still be present and visible through the same
-- family of functions.
--
-- Eleven as of CP4, not ten: `movements` was the one table
-- `authenticated` could not read, on the Phase 4 ground that nothing
-- needed the parent. The movement edit surface does, so the exclusion
-- is gone and every table in this schema is now readable by its owner.
select is(
  (select count(*)::int from write_posture_tables t
   where has_table_privilege('authenticated', 'public.' || t.name, 'select')),
  11,
  'authenticated now holds SELECT on all 11 tables (the checks above are not vacuous)'
);

-- ============================================================
-- Behavioral: authenticated cannot write the remaining seven tables
-- ============================================================

reset role;
set local role authenticated;
-- A verified-claim uid, exactly as PostgREST sets it. No fixture rows
-- and no auth.users row are needed: the privilege check runs at
-- executor start, before any row is examined, so these statements can
-- never reach a constraint, a policy, or a row.
set local request.jwt.claim.sub = '18000000-0000-4000-8000-000000000001';

-- `default values` keeps the statement uniform across tables with
-- different columns. Were the grant ever present, this would fail on a
-- NOT NULL column (23502) instead -- a different error, so the
-- assertion cannot pass for the wrong reason.
select throws_ok(
  format('insert into public.%I default values', t.name),
  '42501',
  null,
  format('authenticated INSERT on %s is denied at the GRANT layer', t.name)
) from write_posture_tables t
where t.name not in (select name from writable_tables);

-- `where false` still requires the UPDATE privilege: permission is
-- checked before the qualifier is evaluated.
--
-- Excluded by `updatable_tables`, not `writable_tables`, so `movements`
-- is *included* in this loop: it holds INSERT and DELETE but no UPDATE,
-- and this is the statement that proves it behaviorally rather than only
-- in the catalog.
select throws_ok(
  format('update public.%I set user_id = user_id where false', t.name),
  '42501',
  null,
  format('authenticated UPDATE on %s is denied at the GRANT layer', t.name)
) from write_posture_tables t
where t.name <> 'profiles'
  and t.name not in (select name from updatable_tables);

-- profiles has no user_id column -- its primary key *is* the user id.
select throws_ok(
  $$ update public.profiles set timezone = timezone where false $$,
  '42501',
  null,
  'authenticated UPDATE on profiles is denied at the GRANT layer'
);

-- DELETE covers nine of the eleven -- accounts and categories included,
-- since neither CP2 nor CP3 nor CP4 adds a DELETE grant to either.
-- transactions and movements are the two exceptions, excluded by the
-- list rather than by name so the exception cannot silently grow.
select throws_ok(
  format('delete from public.%I where false', t.name),
  '42501',
  null,
  format('authenticated DELETE on %s is denied at the GRANT layer', t.name)
) from write_posture_tables t
where t.name not in (select name from deletable_tables);

-- ============================================================
-- Behavioral: the ungranted columns of the two writable tables
-- ============================================================
-- The column list is what stands between "rename my account" and
-- "reassign my account to someone else", so each excluded column is
-- asserted by an actual statement, not only by the catalog above.

select throws_ok(
  $$ update public.accounts set user_id = user_id where false $$,
  '42501', null,
  'authenticated cannot UPDATE accounts.user_id -- an account can never be re-homed'
);
select throws_ok(
  $$ update public.accounts set id = id where false $$,
  '42501', null,
  'authenticated cannot UPDATE accounts.id'
);
select throws_ok(
  $$ update public.accounts set type = type where false $$,
  '42501', null,
  'authenticated cannot UPDATE accounts.type -- immutable at the GRANT layer as well as by trigger'
);
select throws_ok(
  $$ update public.accounts set created_at = created_at where false $$,
  '42501', null,
  'authenticated cannot UPDATE accounts.created_at'
);

select throws_ok(
  $$ update public.categories set user_id = user_id where false $$,
  '42501', null,
  'authenticated cannot UPDATE categories.user_id'
);
select throws_ok(
  $$ update public.categories set id = id where false $$,
  '42501', null,
  'authenticated cannot UPDATE categories.id'
);

-- transactions' four excluded UPDATE columns, each by an actual
-- statement. `id` and `movement_id` are the two that are new in kind:
-- an editable id would let an idempotency collision be edited away, and
-- an editable movement_id would let an ordinary row be adopted into a
-- movement (or a leg re-parented) -- which validate_movement() would
-- catch at COMMIT, but this makes it impossible rather than futile.
select throws_ok(
  $$ update public.transactions set user_id = user_id where false $$,
  '42501', null,
  'authenticated cannot UPDATE transactions.user_id -- a transaction can never be re-homed'
);
select throws_ok(
  $$ update public.transactions set id = id where false $$,
  '42501', null,
  'authenticated cannot UPDATE transactions.id -- the idempotency key is chosen once'
);
select throws_ok(
  $$ update public.transactions set movement_id = movement_id where false $$,
  '42501', null,
  'authenticated cannot UPDATE transactions.movement_id -- no re-parenting, no adoption into a movement'
);
select throws_ok(
  $$ update public.transactions set created_at = now() where false $$,
  '42501', null,
  'authenticated cannot UPDATE transactions.created_at -- the same-day ordering tie-break'
);

-- INSERT is column-scoped too: naming a column outside the grant fails
-- at the privilege layer before any value is considered.
select throws_ok(
  $$ insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents)
     values ('18000000-0000-4000-8000-0000000000a9', '18000000-0000-4000-8000-000000000001', 'x', 'y', 'checking', 0) $$,
  '42501', null,
  'authenticated cannot choose an accounts.id on INSERT'
);
select throws_ok(
  $$ insert into public.categories (user_id, name, kind, is_archived)
     values ('18000000-0000-4000-8000-000000000001', 'x', 'expense', true) $$,
  '42501', null,
  'authenticated cannot create an already-archived category'
);
select throws_ok(
  $$ insert into public.transactions (user_id, account_id, date, merchant, kind, amount_cents, created_at)
     values ('18000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-0000000000a9', '2026-01-01', 'x', 'expense', -1, now()) $$,
  '42501', null,
  'authenticated cannot backdate a transactions.created_at on INSERT'
);
select throws_ok(
  $$ insert into public.movements (id, user_id, kind, created_at)
     values ('18000000-0000-4000-8000-0000000000b9', '18000000-0000-4000-8000-000000000001', 'transfer', now()) $$,
  '42501', null,
  'authenticated cannot backdate a movements.created_at on INSERT'
);
select throws_ok(
  $$ update public.movements set kind = kind where false $$,
  '42501', null,
  'authenticated cannot UPDATE movements.kind -- an edit rewrites the pair, it does not retype the parent'
);

-- budgets' four excluded UPDATE columns: only limit_cents survives.
-- Getting the category or the month wrong means delete-and-recreate, not
-- an in-place edit.
select throws_ok(
  $$ update public.budgets set user_id = user_id where false $$,
  '42501', null,
  'authenticated cannot UPDATE budgets.user_id -- a budget can never be re-homed'
);
select throws_ok(
  $$ update public.budgets set id = id where false $$,
  '42501', null,
  'authenticated cannot UPDATE budgets.id'
);
select throws_ok(
  $$ update public.budgets set category_id = category_id where false $$,
  '42501', null,
  'authenticated cannot UPDATE budgets.category_id -- wrong category means delete and recreate'
);
select throws_ok(
  $$ update public.budgets set period = period where false $$,
  '42501', null,
  'authenticated cannot UPDATE budgets.period -- wrong month means delete and recreate'
);

-- goals' two excluded UPDATE columns.
select throws_ok(
  $$ update public.goals set user_id = user_id where false $$,
  '42501', null,
  'authenticated cannot UPDATE goals.user_id -- a goal can never be re-homed'
);
select throws_ok(
  $$ update public.goals set id = id where false $$,
  '42501', null,
  'authenticated cannot UPDATE goals.id'
);

select throws_ok(
  $$ insert into public.goals (id, user_id, name, target_cents, target_date, archived_at)
     values ('18000000-0000-4000-8000-0000000000c1', '18000000-0000-4000-8000-000000000001', 'x', 100, null, now()) $$,
  '42501', null,
  'authenticated cannot create an already-archived goal'
);
select throws_ok(
  $$ insert into public.goal_contributions (id, user_id, goal_id, amount_cents, occurred_on, created_at)
     values ('18000000-0000-4000-8000-0000000000c2', '18000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-0000000000c1', 100, '2026-01-01', now()) $$,
  '42501', null,
  'authenticated cannot backdate a goal_contributions.created_at on INSERT'
);

-- bills' three excluded UPDATE columns, plus the two INSERT exclusions.
select throws_ok(
  $$ update public.bills set user_id = user_id where false $$,
  '42501', null,
  'authenticated cannot UPDATE bills.user_id -- a bill can never be re-homed'
);
select throws_ok(
  $$ update public.bills set id = id where false $$,
  '42501', null,
  'authenticated cannot UPDATE bills.id -- the idempotency key is chosen once'
);
select throws_ok(
  $$ update public.bills set created_at = now() where false $$,
  '42501', null,
  'authenticated cannot UPDATE bills.created_at'
);
select throws_ok(
  $$ insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date, is_archived)
     values ('18000000-0000-4000-8000-0000000000d1', '18000000-0000-4000-8000-000000000001', 'x', 1, 'monthly', '2026-01-01', true) $$,
  '42501', null,
  'authenticated cannot create an already-archived bill'
);
select throws_ok(
  $$ insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date, created_at)
     values ('18000000-0000-4000-8000-0000000000d2', '18000000-0000-4000-8000-000000000001', 'x', 1, 'monthly', '2026-01-01', now()) $$,
  '42501', null,
  'authenticated cannot backdate a bills.created_at on INSERT'
);

-- bill_occurrences' excluded UPDATE columns, each by an actual statement.
-- `amount_cents` and `due_date` are the two that matter most: they are
-- what this instance was due for and when, fixed at generation time.
select throws_ok(
  $$ update public.bill_occurrences set amount_cents = amount_cents where false $$,
  '42501', null,
  'authenticated cannot UPDATE bill_occurrences.amount_cents -- fixed at generation time'
);
select throws_ok(
  $$ update public.bill_occurrences set due_date = due_date where false $$,
  '42501', null,
  'authenticated cannot UPDATE bill_occurrences.due_date -- an obligation''s date is not editable'
);
select throws_ok(
  $$ update public.bill_occurrences set bill_id = bill_id where false $$,
  '42501', null,
  'authenticated cannot UPDATE bill_occurrences.bill_id -- no re-parenting'
);
select throws_ok(
  $$ update public.bill_occurrences set user_id = user_id where false $$,
  '42501', null,
  'authenticated cannot UPDATE bill_occurrences.user_id'
);
select throws_ok(
  $$ update public.bill_occurrences set id = id where false $$,
  '42501', null,
  'authenticated cannot UPDATE bill_occurrences.id'
);
select throws_ok(
  $$ update public.bill_occurrences set created_at = now() where false $$,
  '42501', null,
  'authenticated cannot UPDATE bill_occurrences.created_at'
);
-- ============================================================
-- Behavioral: anon cannot write either
-- ============================================================
--
-- anon has no grant of any kind, so no claim is set: the request never
-- reaches RLS. Spot-checked rather than exhaustive -- the catalog half
-- above already covers every table for this role -- but deliberately
-- spot-checked on all three tables the application can write, DELETE
-- included, since transactions is the first table where DELETE is
-- granted to anyone at all.

reset role;
set local role anon;

select throws_ok(
  $$ insert into public.accounts (user_id, name, institution, type, opening_balance_cents)
     values ('18000000-0000-4000-8000-000000000001', 'x', 'y', 'checking', 0) $$,
  '42501', null, 'anon INSERT on accounts is denied at the GRANT layer'
);
select throws_ok(
  $$ insert into public.categories (user_id, name, kind)
     values ('18000000-0000-4000-8000-000000000001', 'x', 'expense') $$,
  '42501', null, 'anon INSERT on categories is denied at the GRANT layer'
);
select throws_ok(
  $$ update public.accounts set name = 'x' where false $$,
  '42501', null, 'anon UPDATE on accounts is denied at the GRANT layer'
);
select throws_ok(
  $$ update public.categories set name = 'x' where false $$,
  '42501', null, 'anon UPDATE on categories is denied at the GRANT layer'
);
select throws_ok(
  $$ insert into public.transactions (user_id, account_id, date, merchant, kind, amount_cents)
     values ('18000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-0000000000a9', '2026-01-01', 'x', 'expense', -1) $$,
  '42501', null, 'anon INSERT on transactions is denied at the GRANT layer'
);
select throws_ok(
  $$ delete from public.transactions where false $$,
  '42501', null, 'anon DELETE on transactions is denied at the GRANT layer'
);
select throws_ok(
  $$ insert into public.movements (id, user_id, kind)
     values ('18000000-0000-4000-8000-0000000000ba', '18000000-0000-4000-8000-000000000001', 'transfer') $$,
  '42501', null, 'anon INSERT on movements is denied at the GRANT layer'
);
select throws_ok(
  $$ delete from public.movements where false $$,
  '42501', null, 'anon DELETE on movements is denied at the GRANT layer'
);
select throws_ok(
  $$ insert into public.budgets (user_id, category_id, period, limit_cents)
     values ('18000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-0000000000c9', '2026-01', 1000) $$,
  '42501', null, 'anon INSERT on budgets is denied at the GRANT layer'
);
select throws_ok(
  $$ delete from public.budgets where false $$,
  '42501', null, 'anon DELETE on budgets is denied at the GRANT layer -- CP6''s new grant, anon still excluded'
);
-- And the two RPCs are unreachable for anon at the privilege layer,
-- before any argument is examined -- which is what makes "an anonymous
-- request cannot create a movement" true regardless of what the function
-- body checks.
select throws_ok(
  $$ select public.create_movement(
       '18000000-0000-4000-8000-0000000000bb', 'transfer', '2026-01-01',
       '18000000-0000-4000-8000-0000000000a9', '18000000-0000-4000-8000-0000000000aa',
       100, '18000000-0000-4000-8000-0000000000bc', '18000000-0000-4000-8000-0000000000bd') $$,
  '42501', null, 'anon EXECUTE of create_movement is denied at the GRANT layer'
);
select throws_ok(
  $$ select public.replace_movement(
       '18000000-0000-4000-8000-0000000000bb', 'transfer', '2026-01-01',
       '18000000-0000-4000-8000-0000000000a9', '18000000-0000-4000-8000-0000000000aa',
       100, '18000000-0000-4000-8000-0000000000bc', '18000000-0000-4000-8000-0000000000bd') $$,
  '42501', null, 'anon EXECUTE of replace_movement is denied at the GRANT layer'
);

-- CP7's two new relations and its four new RPCs, for the same role.
-- `maintain_bill_schedule` is the one that matters most here: it is the
-- only SECURITY DEFINER function CP7 adds, so an anonymous caller
-- reaching it would be running as finance_snapshot_writer. It cannot,
-- and the refusal happens at the privilege layer before a single
-- argument is examined.
select throws_ok(
  $$ insert into public.bills (user_id, name, amount_cents, frequency, anchor_date)
     values ('18000000-0000-4000-8000-000000000001', 'x', 1, 'monthly', '2026-01-01') $$,
  '42501', null, 'anon INSERT on bills is denied at the GRANT layer'
);
select throws_ok(
  $$ update public.bills set name = 'x' where false $$,
  '42501', null, 'anon UPDATE on bills is denied at the GRANT layer'
);
select throws_ok(
  $$ update public.bill_occurrences set status = 'paid' where false $$,
  '42501', null, 'anon UPDATE on bill_occurrences is denied at the GRANT layer'
);
select throws_ok(
  $$ select public.create_bill('18000000-0000-4000-8000-0000000000d9', 'x', 1, 'monthly', '2026-01-01', null, null) $$,
  '42501', null, 'anon EXECUTE of create_bill is denied at the GRANT layer'
);
select throws_ok(
  $$ select public.replace_bill('18000000-0000-4000-8000-0000000000d9', 'x', 1, 'monthly', '2026-01-01', null, null) $$,
  '42501', null, 'anon EXECUTE of replace_bill is denied at the GRANT layer'
);
select throws_ok(
  $$ select public.set_bill_archived('18000000-0000-4000-8000-0000000000d9', true) $$,
  '42501', null, 'anon EXECUTE of set_bill_archived is denied at the GRANT layer'
);
select throws_ok(
  $$ select public.maintain_bill_schedule('18000000-0000-4000-8000-0000000000d9', true) $$,
  '42501', null, 'anon EXECUTE of maintain_bill_schedule is denied at the GRANT layer -- the one CP7 definer'
);

-- Phase 8 CP1's two new RPCs, for the same role. They are the first
-- functions an anonymous caller reaching them could use to write the
-- *ledger*, so their refusal at the privilege layer -- before a single
-- argument is examined -- is worth stating.
select throws_ok(
  $$ select public.settle_bill_occurrence(
       '18000000-0000-4000-8000-0000000000e1', '2026-01-01', null,
       '18000000-0000-4000-8000-0000000000e2') $$,
  '42501', null, 'anon EXECUTE of settle_bill_occurrence is denied at the GRANT layer'
);
select throws_ok(
  $$ select public.unsettle_bill_occurrence('18000000-0000-4000-8000-0000000000e1') $$,
  '42501', null, 'anon EXECUTE of unsettle_bill_occurrence is denied at the GRANT layer'
);

reset role;

-- ============================================================
-- Completeness of the table list itself
-- ============================================================

select is(
  (select count(*)::int from pg_tables
   where schemaname = 'public'
     and tablename not in (select name from write_posture_tables)),
  0,
  'every table in the public schema is covered by the write-grant checks above'
);

select * from finish();
rollback;
