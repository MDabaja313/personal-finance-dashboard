-- Write-privilege posture: the application is still read-only.
--
-- Phase 7 CP1 builds the reusable write *foundation* (validation, the
-- ActionState contract, the write error mapper, the layer fences) and
-- deliberately ships no migration, no write GRANT, no write RLS policy,
-- and no mutating code. This file is what proves the database half of
-- that claim, so "CP1 changed no privilege" is a checked fact rather
-- than a promise in a commit message -- and so CP2 cannot quietly widen
-- a grant beyond the one operation it is adding without a test turning
-- red here.
--
-- Two layers, both asserted, because either alone is insufficient:
--
--   * Catalog: has_table_privilege() over every user-financial table
--     for both application roles. This is the exhaustive half -- it
--     cannot miss a table -- and the final assertion proves the table
--     list itself is complete, so a table added by a later migration
--     cannot escape the check by not being named here.
--   * Behavioral: real INSERT/UPDATE/DELETE statements executed as
--     `authenticated` (with a verified-claim uid set, exactly as
--     PostgREST does) and as `anon`, each asserted to fail with 42501.
--     A catalog inspection alone would not notice a write reaching the
--     table by some other route; a statement that actually runs would.
--
-- 42501 is insufficient_privilege: the GRANT layer refuses the
-- operation before RLS is ever consulted. That distinction matters --
-- a missing *policy* on a granted table returns zero rows rather than
-- an error, so a grant-layer denial is the stronger of the two, and it
-- is what `authenticated` hits on every write today.
begin;
select plan(44);

-- Every user-financial table. The last assertion in this file proves
-- this list is exactly `public`'s table set, so it cannot silently fall
-- behind a migration.
create temporary table write_posture_tables (name text primary key) on commit drop;
insert into write_posture_tables (name) values
  ('profiles'), ('accounts'), ('categories'), ('movements'), ('transactions'),
  ('budgets'), ('bills'), ('bill_occurrences'), ('goals'), ('goal_contributions'),
  ('net_worth_snapshots');

-- The behavioral section below reads this list while running *as*
-- `authenticated`/`anon`, so those roles need to see it. Scoped to a
-- transaction-local temporary table that is dropped at commit and
-- rolled back regardless: this is a test-harness concern only and
-- grants nothing on any application object.
grant select on write_posture_tables to authenticated, anon;

-- ============================================================
-- Catalog: zero write grants, either role, every table
-- ============================================================

select is(
  (select count(*)::int from write_posture_tables t
   where has_table_privilege('anon', 'public.' || t.name, 'insert')),
  0,
  'anon has zero INSERT grants across every user-financial table'
);
select is(
  (select count(*)::int from write_posture_tables t
   where has_table_privilege('anon', 'public.' || t.name, 'update')),
  0,
  'anon has zero UPDATE grants across every user-financial table'
);
select is(
  (select count(*)::int from write_posture_tables t
   where has_table_privilege('anon', 'public.' || t.name, 'delete')),
  0,
  'anon has zero DELETE grants across every user-financial table'
);

select is(
  (select count(*)::int from write_posture_tables t
   where has_table_privilege('authenticated', 'public.' || t.name, 'insert')),
  0,
  'authenticated has zero INSERT grants across every user-financial table'
);
select is(
  (select count(*)::int from write_posture_tables t
   where has_table_privilege('authenticated', 'public.' || t.name, 'update')),
  0,
  'authenticated has zero UPDATE grants across every user-financial table'
);
select is(
  (select count(*)::int from write_posture_tables t
   where has_table_privilege('authenticated', 'public.' || t.name, 'delete')),
  0,
  'authenticated has zero DELETE grants across every user-financial table'
);

-- The two security_invoker views are separately grantable objects; a
-- write grant on one would be as real as a write grant on a table.
select is(
  (select count(*)::int from (values ('account_balances'), ('goal_balances')) as v(name)
   cross join (values ('anon'), ('authenticated')) as r(role)
   where has_table_privilege(r.role, 'public.' || v.name, 'insert')
      or has_table_privilege(r.role, 'public.' || v.name, 'update')
      or has_table_privilege(r.role, 'public.' || v.name, 'delete')),
  0,
  'neither application role has any write grant on account_balances or goal_balances'
);

-- Guard against a vacuous pass: if the table names above were
-- misspelled, has_table_privilege() would error rather than return
-- false -- but a role name that granted nothing anywhere would make
-- every count above trivially zero. The Phase 6 read grants must still
-- be present and visible through the same function.
select is(
  (select count(*)::int from write_posture_tables t
   where t.name <> 'movements'
     and has_table_privilege('authenticated', 'public.' || t.name, 'select')),
  10,
  'authenticated still holds SELECT on all 10 readable tables (the checks above are not vacuous)'
);

-- ============================================================
-- Behavioral: authenticated cannot write, table by table
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
) from write_posture_tables t;

-- `where false` still requires the UPDATE/DELETE privilege: permission
-- is checked before the qualifier is evaluated.
select throws_ok(
  format('update public.%I set user_id = user_id where false', t.name),
  '42501',
  null,
  format('authenticated UPDATE on %s is denied at the GRANT layer', t.name)
) from write_posture_tables t where t.name <> 'profiles';

-- profiles has no user_id column -- its primary key *is* the user id.
select throws_ok(
  $$ update public.profiles set timezone = timezone where false $$,
  '42501',
  null,
  'authenticated UPDATE on profiles is denied at the GRANT layer'
);

select throws_ok(
  format('delete from public.%I where false', t.name),
  '42501',
  null,
  format('authenticated DELETE on %s is denied at the GRANT layer', t.name)
) from write_posture_tables t;

-- ============================================================
-- Behavioral: anon cannot write either
-- ============================================================
--
-- anon has no grant of any kind, so no claim is set: the request never
-- reaches RLS. Spot-checked rather than exhaustive -- the catalog half
-- above already covers every table for this role.

reset role;
set local role anon;

select throws_ok(
  $$ insert into public.accounts default values $$,
  '42501', null, 'anon INSERT on accounts is denied at the GRANT layer'
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
