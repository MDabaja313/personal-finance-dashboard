-- Row Level Security: ownership isolation on the 10 grant-bearing
-- tables, movements' deliberate GRANT-layer exclusion, anon's total
-- exclusion, write-denial for authenticated, and both security_invoker
-- views. All fixture setup runs as the migration owner (postgres is
-- superuser, so it bypasses FORCE ROW LEVEL SECURITY entirely -- the
-- same reason 020/030/040/050 could seed rows directly). Role/claim
-- switches use the verified local auth.uid() form:
--   SET LOCAL ROLE authenticated;
--   SET LOCAL request.jwt.claim.sub = '<uuid>';
-- `RESET ROLE` returns to the session role (postgres, superuser) before
-- every switch, since a non-superuser role cannot SET ROLE onward to an
-- unrelated role.
--
-- Permission denial (GRANT layer, e.g. movements/anon) and RLS row
-- filtering are distinguished deliberately: a missing GRANT raises
-- 42501 before RLS is ever consulted; a granted-but-unmatched SELECT
-- returns zero rows, not an error.
begin;
select plan(41);

-- ============================================================
-- Fixture: two users, one row in each of the 10 grant-bearing tables,
-- per user.
-- ============================================================

insert into auth.users (id, aud, role, email) values
  ('14000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'rls-a@local.test'),
  ('14000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'rls-b@local.test');
insert into public.profiles (id) values
  ('14000000-0000-4000-8000-000000000001'),
  ('14000000-0000-4000-8000-000000000002');

insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('14000000-0000-4000-8000-0000000000a1', '14000000-0000-4000-8000-000000000001', 'A-acct', 'Bank', 'checking', 1000),
  ('14000000-0000-4000-8000-0000000000a2', '14000000-0000-4000-8000-000000000002', 'B-acct', 'Bank', 'checking', 2000);

insert into public.categories (id, user_id, name, kind) values
  ('14000000-0000-4000-8000-0000000000c1', '14000000-0000-4000-8000-000000000001', 'A-cat', 'expense'),
  ('14000000-0000-4000-8000-0000000000c2', '14000000-0000-4000-8000-000000000002', 'B-cat', 'expense');

insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, amount_cents) values
  ('14000000-0000-4000-8000-000000000101', '14000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-0000000000a1', '2026-01-01', 'A-txn', 'expense', '14000000-0000-4000-8000-0000000000c1', -100),
  ('14000000-0000-4000-8000-000000000102', '14000000-0000-4000-8000-000000000002', '14000000-0000-4000-8000-0000000000a2', '2026-01-01', 'B-txn', 'expense', '14000000-0000-4000-8000-0000000000c2', -200);

insert into public.budgets (id, user_id, category_id, period, limit_cents) values
  ('14000000-0000-4000-8000-0000000000b1', '14000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-0000000000c1', '2026-01', 1000),
  ('14000000-0000-4000-8000-0000000000b2', '14000000-0000-4000-8000-000000000002', '14000000-0000-4000-8000-0000000000c2', '2026-01', 2000);

insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date) values
  ('14000000-0000-4000-8000-000000000201', '14000000-0000-4000-8000-000000000001', 'A-bill', 100, 'monthly', '2026-01-01'),
  ('14000000-0000-4000-8000-000000000202', '14000000-0000-4000-8000-000000000002', 'B-bill', 200, 'monthly', '2026-01-01');

insert into public.bill_occurrences (id, user_id, bill_id, due_date, status, amount_cents) values
  ('14000000-0000-4000-8000-000000000301', '14000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000201', '2026-01-01', 'scheduled', 100),
  ('14000000-0000-4000-8000-000000000302', '14000000-0000-4000-8000-000000000002', '14000000-0000-4000-8000-000000000202', '2026-01-01', 'scheduled', 200);

insert into public.goals (id, user_id, name, target_cents) values
  ('14000000-0000-4000-8000-000000000401', '14000000-0000-4000-8000-000000000001', 'A-goal', 1000),
  ('14000000-0000-4000-8000-000000000402', '14000000-0000-4000-8000-000000000002', 'B-goal', 2000);

insert into public.goal_contributions (id, user_id, goal_id, amount_cents, occurred_on) values
  ('14000000-0000-4000-8000-000000000501', '14000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000401', 100, '2026-01-01'),
  ('14000000-0000-4000-8000-000000000502', '14000000-0000-4000-8000-000000000002', '14000000-0000-4000-8000-000000000402', 200, '2026-01-01');

insert into public.net_worth_snapshots (user_id, month, assets_cents, liabilities_cents, net_worth_cents) values
  ('14000000-0000-4000-8000-000000000001', '2026-01', 1000, 0, 1000),
  ('14000000-0000-4000-8000-000000000002', '2026-01', 2000, 0, 2000);

-- ============================================================
-- Switch to authenticated, claiming user A. `select auth.uid()` proves
-- the claim actually took effect before relying on it for RLS.
-- ============================================================

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '14000000-0000-4000-8000-000000000001';

select is(
  (select auth.uid()),
  '14000000-0000-4000-8000-000000000001'::uuid,
  'auth.uid() reflects the request.jwt.claim.sub GUC for user A'
);

-- authenticated (A) sees own rows on the 10 readable tables, and zero
-- of user B's rows -- one row exists per user per table, so a count of
-- exactly 1 proves both properties in a single assertion per table.
select is((select count(*)::int from public.profiles), 1, 'A sees exactly own profile row');
select is((select count(*)::int from public.accounts), 1, 'A sees exactly own accounts row');
select is((select count(*)::int from public.categories), 1, 'A sees exactly own categories row');
select is((select count(*)::int from public.transactions), 1, 'A sees exactly own transactions row');
select is((select count(*)::int from public.budgets), 1, 'A sees exactly own budgets row');
select is((select count(*)::int from public.bills), 1, 'A sees exactly own bills row');
select is((select count(*)::int from public.bill_occurrences), 1, 'A sees exactly own bill_occurrences row');
select is((select count(*)::int from public.goals), 1, 'A sees exactly own goals row');
select is((select count(*)::int from public.goal_contributions), 1, 'A sees exactly own goal_contributions row');
select is((select count(*)::int from public.net_worth_snapshots), 1, 'A sees exactly own net_worth_snapshots row');

-- Explicit filter-by-other-user's-id form, on two representative
-- tables using the two different ownership predicates in the schema
-- (auth.uid() = id on profiles; auth.uid() = user_id everywhere else).
select is(
  (select count(*)::int from public.profiles where id = '14000000-0000-4000-8000-000000000002'),
  0,
  'A explicitly sees zero profile rows filtered to B''s id'
);
select is(
  (select count(*)::int from public.accounts where user_id = '14000000-0000-4000-8000-000000000002'),
  0,
  'A explicitly sees zero account rows filtered to B''s user_id'
);

-- movements: no GRANT exists for authenticated at all -- fails at the
-- privilege layer (42501), before RLS (which has no policy on this
-- table either) is ever consulted.
select throws_ok(
  $$ select count(*) from public.movements $$,
  '42501',
  null,
  'authenticated querying movements fails with permission denied (GRANT layer, not RLS)'
);

-- Both security_invoker views respect ownership: A sees only A's own
-- account/goal balance rows.
select is((select count(*)::int from public.account_balances), 1, 'A sees exactly own row via account_balances (security_invoker)');
select is(
  (select balance_cents from public.account_balances where id = '14000000-0000-4000-8000-0000000000a1'),
  900::bigint,
  'A sees the correct balance for A''s own account via account_balances (opening 1000 - 100 txn)'
);
select is((select count(*)::int from public.goal_balances), 1, 'A sees exactly own row via goal_balances (security_invoker)');
select is(
  (select saved_cents from public.goal_balances where id = '14000000-0000-4000-8000-000000000401'),
  100::bigint,
  'A sees the correct saved_cents for A''s own goal via goal_balances'
);

-- authenticated INSERT/UPDATE/DELETE remain denied across every
-- operation and a representative spread of tables -- no write GRANT
-- exists on any table through Phase 6, so every attempt fails 42501
-- regardless of ownership.
select throws_ok(
  $$ insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values ('14000000-0000-4000-8000-0000000000a3', '14000000-0000-4000-8000-000000000001', 'X', 'Bank', 'checking', 0) $$,
  '42501', null,
  'authenticated INSERT on accounts (even own row) is denied at the GRANT layer'
);
select throws_ok(
  $$ update public.transactions set merchant = 'changed' where id = '14000000-0000-4000-8000-000000000101' $$,
  '42501', null,
  'authenticated UPDATE on transactions (even own row) is denied at the GRANT layer'
);
select throws_ok(
  $$ delete from public.goals where id = '14000000-0000-4000-8000-000000000401' $$,
  '42501', null,
  'authenticated DELETE on goals (even own row) is denied at the GRANT layer'
);
select throws_ok(
  $$ update public.profiles set timezone = 'America/New_York' where id = '14000000-0000-4000-8000-000000000001' $$,
  '42501', null,
  'authenticated UPDATE on profiles (even own row) is denied at the GRANT layer'
);

-- ============================================================
-- Switch to authenticated, claiming user B: symmetric coverage --
-- ownership isolation is not accidentally one-directional.
-- ============================================================

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '14000000-0000-4000-8000-000000000002';

select is((select count(*)::int from public.profiles), 1, 'B sees exactly own profile row');
select is((select count(*)::int from public.accounts), 1, 'B sees exactly own accounts row');
select is((select count(*)::int from public.transactions), 1, 'B sees exactly own transactions row');
select is((select count(*)::int from public.goals), 1, 'B sees exactly own goals row');
select is(
  (select count(*)::int from public.transactions where user_id = '14000000-0000-4000-8000-000000000001'),
  0,
  'B explicitly sees zero transaction rows filtered to A''s user_id'
);
select is((select count(*)::int from public.account_balances), 1, 'B sees exactly own row via account_balances (security_invoker)');
select is(
  (select balance_cents from public.account_balances where id = '14000000-0000-4000-8000-0000000000a2'),
  1800::bigint,
  'B sees the correct balance for B''s own account via account_balances (opening 2000 - 200 txn)'
);

-- ============================================================
-- anon: total exclusion from every user-financial table/view. No
-- anon.uid() claim is set -- anon has no GRANT at all, so the request
-- never reaches RLS.
-- ============================================================

reset role;
set local role anon;

select throws_ok($$ select count(*) from public.profiles $$, '42501', null, 'anon read of profiles is denied at the GRANT layer');
select throws_ok($$ select count(*) from public.accounts $$, '42501', null, 'anon read of accounts is denied at the GRANT layer');
select throws_ok($$ select count(*) from public.transactions $$, '42501', null, 'anon read of transactions is denied at the GRANT layer');
select throws_ok($$ select count(*) from public.budgets $$, '42501', null, 'anon read of budgets is denied at the GRANT layer');
select throws_ok($$ select count(*) from public.bills $$, '42501', null, 'anon read of bills is denied at the GRANT layer');
select throws_ok($$ select count(*) from public.bill_occurrences $$, '42501', null, 'anon read of bill_occurrences is denied at the GRANT layer');
select throws_ok($$ select count(*) from public.goals $$, '42501', null, 'anon read of goals is denied at the GRANT layer');
select throws_ok($$ select count(*) from public.goal_contributions $$, '42501', null, 'anon read of goal_contributions is denied at the GRANT layer');
select throws_ok($$ select count(*) from public.net_worth_snapshots $$, '42501', null, 'anon read of net_worth_snapshots is denied at the GRANT layer');
select throws_ok($$ select count(*) from public.movements $$, '42501', null, 'anon read of movements is denied at the GRANT layer');
select throws_ok($$ select count(*) from public.account_balances $$, '42501', null, 'anon read of account_balances is denied at the GRANT layer');
select throws_ok($$ select count(*) from public.goal_balances $$, '42501', null, 'anon read of goal_balances is denied at the GRANT layer');

reset role;

select * from finish();
rollback;
