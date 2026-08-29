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
select plan(48);

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
       'private.write_net_worth_snapshots_for_range(uuid,text,text)'::regprocedure,
       -- Phase 7 CP5. The one SECURITY DEFINER function this phase adds, and
       -- the only one of the four that lives in `public` and is reachable by
       -- `authenticated` -- which is precisely why its owner matters. It is
       -- finance_snapshot_writer (NOLOGIN, NOSUPERUSER, NOBYPASSRLS, no
       -- members) and never postgres, whose BYPASSRLS attribute would turn a
       -- browser-reachable function into an RLS bypass.
       'public.refresh_current_net_worth_snapshot()'::regprocedure
     )),
  4,
  'all 4 SECURITY DEFINER functions are owned by finance_snapshot_writer'
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
       'public.guard_category_kind_change()'::regprocedure,
       -- Phase 7 CP3.
       'public.assert_transaction_refs()'::regprocedure,
       -- Phase 7 CP4. These two are the only functions in this schema
       -- `authenticated` may EXECUTE, and they are SECURITY INVOKER
       -- despite doing an atomic multi-table write -- which is the shape
       -- people normally reach for SECURITY DEFINER to implement. They do
       -- not need it: the caller already holds every privilege the bodies
       -- use, and under FORCE RLS the invoker sees exactly its own
       -- accounts and movements. A definer's context would not add a
       -- check, it would remove the RLS backing every statement inside.
       'public.create_movement(uuid,public.movement_kind,date,uuid,uuid,bigint,uuid,uuid)'::regprocedure,
       'public.replace_movement(uuid,public.movement_kind,date,uuid,uuid,bigint,uuid,uuid)'::regprocedure,
       -- Phase 7 CP5. reconcile_account is SECURITY INVOKER for the same
       -- reason the CP4 RPCs are: the caller already holds SELECT on accounts
       -- and transactions and INSERT on transactions, and under FORCE RLS the
       -- invoker sees exactly its own rows. request_owner_id is invoker
       -- because it reads two GUCs and needs no privilege at all.
       'public.reconcile_account(uuid,date,bigint)'::regprocedure,
       'private.request_owner_id()'::regprocedure
     )),
  12,
  'all 12 invoker functions are SECURITY INVOKER (prosecdef = false) -- CP5 reconciliation included'
);

-- The four RPCs are the *only* functions `authenticated` may execute
-- anywhere in this schema, and neither PUBLIC nor anon may reach any of
-- them. An unauthenticated caller is `anon`, so this is what makes "an
-- anonymous request cannot create a movement, cannot reconcile an
-- account, and cannot write a snapshot" a privilege-layer fact rather
-- than something each function body has to notice.
select ok(
  has_function_privilege('authenticated', 'public.create_movement(uuid,public.movement_kind,date,uuid,uuid,bigint,uuid,uuid)'::regprocedure, 'execute')
  and has_function_privilege('authenticated', 'public.replace_movement(uuid,public.movement_kind,date,uuid,uuid,bigint,uuid,uuid)'::regprocedure, 'execute')
  and has_function_privilege('authenticated', 'public.reconcile_account(uuid,date,bigint)'::regprocedure, 'execute')
  and has_function_privilege('authenticated', 'public.refresh_current_net_worth_snapshot()'::regprocedure, 'execute'),
  'authenticated may EXECUTE all four public RPCs'
);
select ok(
  not has_function_privilege('anon', 'public.create_movement(uuid,public.movement_kind,date,uuid,uuid,bigint,uuid,uuid)'::regprocedure, 'execute')
  and not has_function_privilege('anon', 'public.replace_movement(uuid,public.movement_kind,date,uuid,uuid,bigint,uuid,uuid)'::regprocedure, 'execute')
  and not has_function_privilege('anon', 'public.reconcile_account(uuid,date,bigint)'::regprocedure, 'execute')
  and not has_function_privilege('anon', 'public.refresh_current_net_worth_snapshot()'::regprocedure, 'execute')
  and not has_function_privilege('public', 'public.create_movement(uuid,public.movement_kind,date,uuid,uuid,bigint,uuid,uuid)'::regprocedure, 'execute')
  and not has_function_privilege('public', 'public.replace_movement(uuid,public.movement_kind,date,uuid,uuid,bigint,uuid,uuid)'::regprocedure, 'execute')
  and not has_function_privilege('public', 'public.reconcile_account(uuid,date,bigint)'::regprocedure, 'execute')
  and not has_function_privilege('public', 'public.refresh_current_net_worth_snapshot()'::regprocedure, 'execute'),
  'neither anon nor the PUBLIC pseudo-role may EXECUTE any of the four RPCs'
);

-- The set of `authenticated`-executable functions in public is exactly
-- those four. Enumerated as a sorted list rather than a count, because a
-- function swapped for another would pass a count.
--
-- Note what is NOT here and must never be: any wrapper that takes a user
-- id or a month. refresh_current_net_worth_snapshot() takes neither, so
-- "the caller can address only its own current month" is a property of
-- the signature rather than of a check inside the body.
select is(
  (select string_agg(p.proname::text, ',' order by p.proname)
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and has_function_privilege('authenticated', p.oid, 'execute')),
  'create_movement,reconcile_account,refresh_current_net_worth_snapshot,replace_movement',
  'authenticated may EXECUTE exactly the four RPCs in public and nothing else'
);

-- The bridge takes no arguments at all. Asserted against the catalog
-- rather than inferred from the signature above, because "zero
-- parameters" is the entire mechanism by which a caller cannot choose an
-- owner or a month -- and a defaulted parameter added later would still
-- be callable with no arguments while quietly accepting one.
select is(
  (select pronargs::int from pg_proc where oid = 'public.refresh_current_net_worth_snapshot()'::regprocedure),
  0,
  'refresh_current_net_worth_snapshot takes zero parameters'
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
  and not has_function_privilege('public', 'private.write_net_worth_snapshots_for_range(uuid,text,text)'::regprocedure, 'execute')
  and not has_function_privilege('public', 'private.request_owner_id()'::regprocedure, 'execute'),
  'the PUBLIC pseudo-role cannot EXECUTE any of the 4 private functions'
);
select ok(
  not has_function_privilege('anon', 'private.generate_bill_occurrences(uuid,date)'::regprocedure, 'execute')
  and not has_function_privilege('anon', 'private.write_net_worth_snapshot(uuid,text)'::regprocedure, 'execute')
  and not has_function_privilege('anon', 'private.write_net_worth_snapshots_for_range(uuid,text,text)'::regprocedure, 'execute')
  and not has_function_privilege('anon', 'private.request_owner_id()'::regprocedure, 'execute'),
  'anon cannot EXECUTE any of the 4 private functions'
);
select ok(
  not has_function_privilege('authenticated', 'private.generate_bill_occurrences(uuid,date)'::regprocedure, 'execute')
  and not has_function_privilege('authenticated', 'private.write_net_worth_snapshot(uuid,text)'::regprocedure, 'execute')
  and not has_function_privilege('authenticated', 'private.write_net_worth_snapshots_for_range(uuid,text,text)'::regprocedure, 'execute')
  and not has_function_privilege('authenticated', 'private.request_owner_id()'::regprocedure, 'execute'),
  'authenticated cannot EXECUTE any of the 4 private functions'
);

-- ============================================================
-- Schema/table reachability
-- ============================================================

-- M14 grants finance_snapshot_writer CREATE on public for exactly one
-- statement -- ALTER FUNCTION ... OWNER TO requires the incoming owner to
-- be able to have created the object -- and revokes it immediately. The
-- ownership is permanent; the privilege must not be. A standing CREATE
-- here would let anything running as the writer add objects to the
-- schema the Data API exposes.
select ok(
  not has_schema_privilege('finance_snapshot_writer', 'public', 'create'),
  'finance_snapshot_writer holds no standing CREATE on schema public'
);
-- It does still own CREATE on private (migration 7), which is what lets
-- it own the functions that live there. Stated so the assertion above
-- reads as "narrowed", not as "the role owns nothing anywhere".
select ok(
  has_schema_privilege('finance_snapshot_writer', 'private', 'create'),
  'finance_snapshot_writer still holds CREATE on schema private'
);

select ok(not has_schema_privilege('anon', 'private', 'usage'), 'private schema has no USAGE grant for anon');
-- Load-bearing for Phase 7 CP4, not merely tidy: `public.create_movement`
-- and `public.replace_movement` are SECURITY INVOKER, so their bodies run
-- with the caller's privileges. That is exactly why neither may reach a
-- helper in `private` -- and why replace_movement composes
-- create_movement instead. If this ever became true, a private helper
-- would look callable from a public RPC and the whole schema's
-- "authenticated cannot reach private" posture would be gone.
select ok(not has_schema_privilege('authenticated', 'private', 'usage'), 'private schema has no USAGE grant for authenticated');
-- movements gained SELECT/INSERT/DELETE in Phase 7 CP4 (the edit surface
-- needs to read the pair as one object). UPDATE is the one that stayed
-- shut, permanently: a movements row is (id, user_id, kind), and changing
-- `kind` in place would contradict every leg's own kind. Rewriting the
-- pair together is replace_movement()'s job.
select ok(not has_table_privilege('authenticated', 'public.movements', 'update'), 'movements has no UPDATE grant for authenticated');

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

-- No access at all to the remaining five tables.
select throws_ok($$ select count(*) from public.categories $$, '42501', null, 'writer has no SELECT grant on categories');
select throws_ok($$ select count(*) from public.movements $$, '42501', null, 'writer has no SELECT grant on movements');
select throws_ok($$ select count(*) from public.budgets $$, '42501', null, 'writer has no SELECT grant on budgets');
select throws_ok($$ select count(*) from public.goals $$, '42501', null, 'writer has no SELECT grant on goals');
select throws_ok($$ select count(*) from public.goal_contributions $$, '42501', null, 'writer has no SELECT grant on goal_contributions');

-- ============================================================
-- profiles: the one privilege Phase 7 CP5 added to the writer
-- ============================================================
-- Through Phase 6 the writer had nothing on profiles at all, and this
-- file asserted exactly that. CP5's snapshot bridge has to know which
-- calendar month the *owner* is in, which means reading that owner's
-- timezone, so the grant arrives with the feature that needs it -- and
-- it arrives as narrowly as the privilege system allows, which the three
-- assertions below pin from three different directions.
--
-- 1. Column-scoped. `created_at` was not granted, so reading it is
--    refused at the privilege layer rather than merely unused.
select throws_ok(
  $$ select created_at from public.profiles $$,
  '42501', null,
  'writer cannot read a profiles column outside the (id, timezone) grant'
);

-- 2. Row-scoped, to the *calling request's* own profile. With no JWT
--    claim in the session there is no caller, so profiles_select_writer
--    matches nothing -- a psql shell or a cron job running as this role
--    enumerates no owners at all. Asserted as a count rather than as an
--    error, because a policy that matched everything would also "not
--    error".
select is(
  (select count(*)::int from public.profiles),
  0,
  'writer sees zero profiles when the session carries no JWT claim'
);

-- 3. …and exactly one when it does. Without this the assertion above
--    would pass just as well for a grant that was silently broken, and
--    the bridge would fail closed in production with a "no profile"
--    error nobody could explain.
set local request.jwt.claim.sub = '17000000-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.profiles),
  1,
  'writer sees exactly the calling claim''s own profile, and no other'
);
select is(
  (select p.timezone from public.profiles p where p.id = '17000000-0000-4000-8000-000000000001'),
  'UTC',
  'writer can actually read the timezone the snapshot bridge needs'
);

reset role;

select * from finish();
rollback;
