-- Privilege verification: the finance_snapshot_writer role's attributes
-- and membership, the SECURITY DEFINER/INVOKER function posture,
-- schema/table reachability for anon and authenticated, and a
-- behavioral proof (not just a catalog inspection) that the writer's
-- object grants and RLS policies together match the approved narrow
-- set -- SELECT-only on accounts/bills/transactions, SELECT+INSERT on
-- bill_occurrences, SELECT+INSERT+UPDATE on net_worth_snapshots, and
-- nothing at all on categories/movements/budgets/goals/
-- goal_contributions/profiles.
--
-- The behavioral checks insert real fixture rows first and assert the
-- writer role's SELECT actually returns them (not just "no error") --
-- a missing policy on a granted table would silently return zero rows,
-- which a bare success check could not distinguish from an empty table.
begin;
select plan(39);

insert into auth.users (id, aud, role, email) values
  ('17000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'priv-test@local.test');
insert into public.profiles (id) values ('17000000-0000-4000-8000-000000000001');
insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('17000000-0000-4000-8000-0000000000a1', '17000000-0000-4000-8000-000000000001', 'Checking', 'Bank', 'checking', 1000);
insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents) values
  ('17000000-0000-4000-8000-000000000101', '17000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000a1', '2026-01-01', 'x', 'expense', -100);
insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date) values
  ('17000000-0000-4000-8000-000000000201', '17000000-0000-4000-8000-000000000001', 'Bill', 100, 'monthly', '2026-01-01');
insert into public.bill_occurrences (id, user_id, bill_id, due_date, status, amount_cents) values
  ('17000000-0000-4000-8000-000000000301', '17000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-000000000201', '2026-01-01', 'scheduled', 100);

-- ============================================================
-- finance_snapshot_writer role attributes
-- ============================================================

select is((select rolcanlogin from pg_roles where rolname = 'finance_snapshot_writer'), false, 'finance_snapshot_writer is NOLOGIN');
select is((select rolsuper from pg_roles where rolname = 'finance_snapshot_writer'), false, 'finance_snapshot_writer is NOSUPERUSER');
select is((select rolbypassrls from pg_roles where rolname = 'finance_snapshot_writer'), false, 'finance_snapshot_writer is NOBYPASSRLS');
select is((select rolcreatedb from pg_roles where rolname = 'finance_snapshot_writer'), false, 'finance_snapshot_writer is NOCREATEDB');
select is((select rolcreaterole from pg_roles where rolname = 'finance_snapshot_writer'), false, 'finance_snapshot_writer is NOCREATEROLE');

-- No application role membership, in either direction.
select is(
  (select count(*)::int from pg_auth_members where roleid = 'finance_snapshot_writer'::regrole and member in ('anon'::regrole, 'authenticated'::regrole)),
  0,
  'neither anon nor authenticated is a member of finance_snapshot_writer'
);
select is(
  (select count(*)::int from pg_auth_members where member = 'finance_snapshot_writer'::regrole and roleid in ('anon'::regrole, 'authenticated'::regrole)),
  0,
  'finance_snapshot_writer is not a member of anon or authenticated'
);

-- ============================================================
-- Function security posture
-- ============================================================

select is(
  (select count(*)::int from pg_proc
   where proowner = 'finance_snapshot_writer'::regrole
     and prosecdef = true
     and oid in (
       'private.generate_bill_occurrences(uuid,date)'::regprocedure,
       'private.write_net_worth_snapshot(uuid,text)'::regprocedure,
       'private.write_net_worth_snapshots_for_range(uuid,text,text)'::regprocedure
     )),
  3,
  'all 3 system functions are owned by finance_snapshot_writer AND SECURITY DEFINER'
);

select is(
  (select count(*)::int from pg_proc
   where prosecdef = false
     and oid in (
       'public.set_updated_at()'::regprocedure,
       'public.validate_profile_timezone()'::regprocedure,
       'public.validate_movement()'::regprocedure,
       'public.guard_bill_occurrence_delete()'::regprocedure,
       'private.next_bill_occurrence_date(date,public.bill_frequency,date)'::regprocedure,
       -- Phase 7 CP2.
       'public.accounts_guard_update()'::regprocedure,
       'public.guard_category_kind_change()'::regprocedure
     )),
  7,
  'all 7 invoker functions are SECURITY INVOKER (prosecdef = false)'
);

-- The two CP2 guards are trigger functions and are never called
-- directly. `authenticated` reaching them by name would be a way to run
-- their body outside a trigger context, so EXECUTE is revoked from it
-- explicitly in the migration as well as by the Phase 4 default-privilege
-- posture -- asserted here rather than assumed.
select ok(
  not has_function_privilege('authenticated', 'public.accounts_guard_update()'::regprocedure, 'execute')
  and not has_function_privilege('authenticated', 'public.guard_category_kind_change()'::regprocedure, 'execute')
  and not has_function_privilege('anon', 'public.accounts_guard_update()'::regprocedure, 'execute')
  and not has_function_privilege('anon', 'public.guard_category_kind_change()'::regprocedure, 'execute'),
  'neither application role can EXECUTE the two CP2 write-guard functions'
);

select ok(
  not has_function_privilege('public', 'private.generate_bill_occurrences(uuid,date)'::regprocedure, 'execute')
  and not has_function_privilege('public', 'private.write_net_worth_snapshot(uuid,text)'::regprocedure, 'execute')
  and not has_function_privilege('public', 'private.write_net_worth_snapshots_for_range(uuid,text,text)'::regprocedure, 'execute'),
  'the PUBLIC pseudo-role cannot EXECUTE any of the 3 system functions'
);
select ok(
  not has_function_privilege('anon', 'private.generate_bill_occurrences(uuid,date)'::regprocedure, 'execute')
  and not has_function_privilege('anon', 'private.write_net_worth_snapshot(uuid,text)'::regprocedure, 'execute')
  and not has_function_privilege('anon', 'private.write_net_worth_snapshots_for_range(uuid,text,text)'::regprocedure, 'execute'),
  'anon cannot EXECUTE any of the 3 system functions'
);
select ok(
  not has_function_privilege('authenticated', 'private.generate_bill_occurrences(uuid,date)'::regprocedure, 'execute')
  and not has_function_privilege('authenticated', 'private.write_net_worth_snapshot(uuid,text)'::regprocedure, 'execute')
  and not has_function_privilege('authenticated', 'private.write_net_worth_snapshots_for_range(uuid,text,text)'::regprocedure, 'execute'),
  'authenticated cannot EXECUTE any of the 3 system functions'
);

-- ============================================================
-- Schema/table reachability
-- ============================================================

select ok(not has_schema_privilege('anon', 'private', 'usage'), 'private schema has no USAGE grant for anon');
select ok(not has_schema_privilege('authenticated', 'private', 'usage'), 'private schema has no USAGE grant for authenticated');
select ok(not has_table_privilege('authenticated', 'public.movements', 'select'), 'movements has no SELECT grant for authenticated');

select is(
  (select count(*)::int from (values
    ('profiles'), ('accounts'), ('categories'), ('movements'), ('transactions'),
    ('budgets'), ('bills'), ('bill_occurrences'), ('goals'), ('goal_contributions'),
    ('net_worth_snapshots'), ('account_balances'), ('goal_balances')
  ) as t(name)
  where has_table_privilege('anon', 'public.' || t.name, 'select')
     or has_table_privilege('anon', 'public.' || t.name, 'insert')
     or has_table_privilege('anon', 'public.' || t.name, 'update')
     or has_table_privilege('anon', 'public.' || t.name, 'delete')),
  0,
  'anon has zero SELECT/INSERT/UPDATE/DELETE grants across every user-financial table and view'
);

-- ============================================================
-- Behavioral proof: the writer's grants + policies together match the
-- approved narrow set. Fixture rows above must actually be visible
-- where a SELECT grant+policy is expected, not merely non-erroring.
-- ============================================================

-- pgTAP's own assertion functions (is/throws_ok/lives_ok/...) live in
-- the `extensions` schema. Supabase's built-in roles (anon,
-- authenticated, postgres) already have USAGE there; finance_snapshot_writer
-- -- a role this schema created, not a Supabase built-in -- does not, so
-- without this grant every pgtap call below would fail to even resolve
-- ("function is(...) does not exist") once the role switch below takes
-- effect. This is scoped to the current transaction (rolled back at the
-- end of this file) and is a test-harness concern only -- it grants
-- nothing the application schema or its migrations rely on.
grant usage on schema extensions to finance_snapshot_writer;

reset role;
set local role finance_snapshot_writer;

select is((select count(*)::int from public.accounts where user_id = '17000000-0000-4000-8000-000000000001'), 1, 'writer SELECT on accounts sees the fixture row (grant + permissive policy both in effect)');
select throws_ok(
  $$ insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values ('17000000-0000-4000-8000-0000000000a2', '17000000-0000-4000-8000-000000000001', 'x', 'Bank', 'checking', 0) $$,
  '42501', null, 'writer INSERT on accounts is denied -- SELECT-only'
);

select is((select count(*)::int from public.transactions where user_id = '17000000-0000-4000-8000-000000000001'), 1, 'writer SELECT on transactions sees the fixture row');
select throws_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents) values ('17000000-0000-4000-8000-000000000102', '17000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000a1', '2026-01-01', 'x', 'expense', -1) $$,
  '42501', null, 'writer INSERT on transactions is denied -- SELECT-only'
);

select is((select count(*)::int from public.bills where user_id = '17000000-0000-4000-8000-000000000001'), 1, 'writer SELECT on bills sees the fixture row');
select throws_ok(
  $$ insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date) values ('17000000-0000-4000-8000-000000000202', '17000000-0000-4000-8000-000000000001', 'x', 1, 'monthly', '2026-01-01') $$,
  '42501', null, 'writer INSERT on bills is denied -- SELECT-only'
);

select is((select count(*)::int from public.bill_occurrences where user_id = '17000000-0000-4000-8000-000000000001'), 1, 'writer SELECT on bill_occurrences sees the fixture row');
select lives_ok(
  $$ insert into public.bill_occurrences (id, user_id, bill_id, due_date, status, amount_cents) values ('17000000-0000-4000-8000-000000000302', '17000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-000000000201', '2026-02-01', 'scheduled', 100) $$,
  'writer INSERT on bill_occurrences succeeds -- generation needs it'
);
select is((select count(*)::int from public.bill_occurrences where user_id = '17000000-0000-4000-8000-000000000001'), 2, 'the writer-inserted bill_occurrences row is actually present');
select throws_ok(
  $$ update public.bill_occurrences set status = 'paid' where id = '17000000-0000-4000-8000-000000000301' $$,
  '42501', null, 'writer UPDATE on bill_occurrences is denied -- no UPDATE grant'
);
select throws_ok(
  $$ delete from public.bill_occurrences where id = '17000000-0000-4000-8000-000000000301' $$,
  '42501', null, 'writer DELETE on bill_occurrences is denied -- no DELETE grant'
);

select is((select count(*)::int from public.net_worth_snapshots where user_id = '17000000-0000-4000-8000-000000000001'), 0, 'writer SELECT on net_worth_snapshots succeeds (no rows yet, not an error)');
select lives_ok(
  $$ insert into public.net_worth_snapshots (user_id, month, assets_cents, liabilities_cents, net_worth_cents) values ('17000000-0000-4000-8000-000000000001', '2026-01', 100, 0, 100) $$,
  'writer INSERT on net_worth_snapshots succeeds -- the upsert target'
);
select is((select count(*)::int from public.net_worth_snapshots where user_id = '17000000-0000-4000-8000-000000000001'), 1, 'the writer-inserted net_worth_snapshots row is actually present');
select lives_ok(
  $$ update public.net_worth_snapshots set assets_cents = 200, net_worth_cents = 200 where user_id = '17000000-0000-4000-8000-000000000001' and month = '2026-01' $$,
  'writer UPDATE on net_worth_snapshots succeeds -- the idempotent ON CONFLICT DO UPDATE path'
);
select throws_ok(
  $$ delete from public.net_worth_snapshots where user_id = '17000000-0000-4000-8000-000000000001' and month = '2026-01' $$,
  '42501', null, 'writer DELETE on net_worth_snapshots is denied -- no DELETE grant'
);

-- No access at all to the remaining six tables.
select throws_ok($$ select count(*) from public.categories $$, '42501', null, 'writer has no SELECT grant on categories');
select throws_ok($$ select count(*) from public.movements $$, '42501', null, 'writer has no SELECT grant on movements');
select throws_ok($$ select count(*) from public.budgets $$, '42501', null, 'writer has no SELECT grant on budgets');
select throws_ok($$ select count(*) from public.goals $$, '42501', null, 'writer has no SELECT grant on goals');
select throws_ok($$ select count(*) from public.goal_contributions $$, '42501', null, 'writer has no SELECT grant on goal_contributions');
select throws_ok($$ select count(*) from public.profiles $$, '42501', null, 'writer has no SELECT grant on profiles');

reset role;

select * from finish();
rollback;
