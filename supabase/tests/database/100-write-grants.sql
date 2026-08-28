-- Write-privilege posture: the exact CP3 matrix, and nothing wider.
--
-- Phase 7 CP1 shipped no migration and no write GRANT at all, and this
-- file proved it. CP2 opened two tables -- accounts and categories --
-- so the file became an allowlist rather than an emptiness check. CP3
-- adds a third, transactions, and with it the first DELETE grant in
-- this schema. The purpose is unchanged and, if anything, sharper: the
-- set of things `authenticated` can write is a checked fact, down to
-- the column, so neither a later checkpoint nor a careless migration
-- can widen it without a test turning red here.
--
-- INSERT/UPDATE: accounts, categories, transactions -- column-scoped in
-- every case. DELETE: transactions and nothing else. Accounts,
-- categories, bills and goals are *labels* historical rows resolve
-- through, so they are archived rather than removed; a transaction is
-- the history itself and has no correct archived state.
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
--   * Column-level catalog. For accounts and categories, the exact set
--     of columns `authenticated` may INSERT and UPDATE, compared as a
--     sorted array against the intended list. A column added to a grant
--     fails this; a column added to the *table* and quietly picked up
--     by a widened grant fails it too.
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
-- Row-level behavior for the two writable tables (own vs. foreign rows,
-- user_id reassignment, anon) is 110-write-rls.sql; the invariant
-- triggers are 120/130.
begin;
select plan(63);

-- Every user-financial table. The last assertion in this file proves
-- this list is exactly `public`'s table set, so it cannot silently fall
-- behind a migration.
create temporary table write_posture_tables (name text primary key) on commit drop;
insert into write_posture_tables (name) values
  ('profiles'), ('accounts'), ('categories'), ('movements'), ('transactions'),
  ('budgets'), ('bills'), ('bill_occurrences'), ('goals'), ('goal_contributions'),
  ('net_worth_snapshots');

-- The tables that hold any INSERT/UPDATE grant, kept as a separate list
-- so every assertion below reads as "these and no others" rather than
-- as a hardcoded name repeated in a dozen places.
create temporary table writable_tables (name text primary key) on commit drop;
insert into writable_tables (name) values ('accounts'), ('categories'), ('transactions');

-- DELETE is tracked separately because it is granted on a strictly
-- narrower set: exactly one table. Folding it into the list above would
-- make "accounts cannot be deleted" untestable.
create temporary table deletable_tables (name text primary key) on commit drop;
insert into deletable_tables (name) values ('transactions');

-- The behavioral section below reads these lists while running *as*
-- `authenticated`/`anon`, so those roles need to see them. Scoped to
-- transaction-local temporary tables that are dropped at commit and
-- rolled back regardless: a test-harness concern only, granting nothing
-- on any application object.
grant select on write_posture_tables, writable_tables, deletable_tables to authenticated, anon;

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
-- Table-level catalog: authenticated writes exactly three tables
-- ============================================================

select is(
  (select count(*)::int from write_posture_tables t
   where has_any_column_privilege('authenticated', 'public.' || t.name, 'insert')
     and t.name not in (select name from writable_tables)),
  0,
  'authenticated has no INSERT grant on any table outside accounts/categories/transactions'
);
select is(
  (select count(*)::int from writable_tables t
   where has_any_column_privilege('authenticated', 'public.' || t.name, 'insert')),
  3,
  'authenticated does hold an INSERT grant on all three writable tables (not vacuous)'
);

select is(
  (select count(*)::int from write_posture_tables t
   where has_any_column_privilege('authenticated', 'public.' || t.name, 'update')
     and t.name not in (select name from writable_tables)),
  0,
  'authenticated has no UPDATE grant on any table outside accounts/categories/transactions'
);
select is(
  (select count(*)::int from writable_tables t
   where has_any_column_privilege('authenticated', 'public.' || t.name, 'update')),
  3,
  'authenticated does hold an UPDATE grant on all three writable tables (not vacuous)'
);

-- DELETE is table-level only -- PostgreSQL has no column-level DELETE
-- privilege at all, so `has_any_column_privilege(..., 'delete')` does
-- not merely fail to help, it raises "unrecognized privilege type".
select is(
  (select count(*)::int from write_posture_tables t
   where has_table_privilege('authenticated', 'public.' || t.name, 'delete')
     and t.name not in (select name from deletable_tables)),
  0,
  'authenticated has no DELETE grant on any table outside transactions -- accounts and categories included'
);
select is(
  (select count(*)::int from deletable_tables t
   where has_table_privilege('authenticated', 'public.' || t.name, 'delete')),
  1,
  'authenticated does hold DELETE on transactions (not vacuous)'
);

-- ============================================================
-- Column-level catalog: the exact CP2/CP3 column matrix
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
select is(
  (select count(*)::int from write_posture_tables t
   where t.name <> 'movements'
     and has_table_privilege('authenticated', 'public.' || t.name, 'select')),
  10,
  'authenticated still holds SELECT on all 10 readable tables (the checks above are not vacuous)'
);

-- ============================================================
-- Behavioral: authenticated cannot write the other eight tables
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
select throws_ok(
  format('update public.%I set user_id = user_id where false', t.name),
  '42501',
  null,
  format('authenticated UPDATE on %s is denied at the GRANT layer', t.name)
) from write_posture_tables t
where t.name <> 'profiles'
  and t.name not in (select name from writable_tables);

-- profiles has no user_id column -- its primary key *is* the user id.
select throws_ok(
  $$ update public.profiles set timezone = timezone where false $$,
  '42501',
  null,
  'authenticated UPDATE on profiles is denied at the GRANT layer'
);

-- DELETE covers ten of the eleven -- accounts and categories included,
-- since CP2 added no DELETE grant to either and CP3 adds none now.
-- transactions is the sole exception, excluded by the list rather than
-- by name so the exception cannot silently grow.
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
