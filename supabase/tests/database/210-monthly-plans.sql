-- Phase 8 Checkpoint 2: expected monthly income.
--
-- The behavior half of 20260902120002_monthly_plans.sql. The privilege matrix
-- is 100-write-grants.sql and the object inventory is 000-objects.sql; this
-- file proves what the table refuses, what it isolates, and — the part that
-- matters most — what it cannot reach.
--
-- Three claims, in order:
--
--   1. **Owner isolation.** One owner's plan is invisible and unwritable to
--      another, on every operation.
--   2. **Month isolation.** A plan is per (owner, month), one row, and a
--      month's row cannot be relabelled into another month.
--   3. **A target is not money.** Writing a plan moves no account balance, no
--      transaction, no budget and no net-worth snapshot — and nothing that
--      computes those can even read this table.
begin;
select plan(25);

-- ============================================================
-- Fixture: two owners, each with an account, a transaction and a budget,
-- so "nothing financial moved" is measured against real figures.
-- ============================================================

insert into auth.users (id, aud, role, email) values
  ('21000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'plan-a@local.test'),
  ('21000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'plan-b@local.test');
insert into public.profiles (id, timezone) values
  ('21000000-0000-4000-8000-000000000001', 'UTC'),
  ('21000000-0000-4000-8000-000000000002', 'UTC');

insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('21000000-0000-4000-8000-0000000000a1', '21000000-0000-4000-8000-000000000001', 'A-checking', 'Bank', 'checking', 250000),
  ('21000000-0000-4000-8000-0000000000a2', '21000000-0000-4000-8000-000000000002', 'B-checking', 'Bank', 'checking', 100000);

insert into public.categories (id, user_id, name, kind) values
  ('21000000-0000-4000-8000-0000000000c1', '21000000-0000-4000-8000-000000000001', 'A-groceries', 'expense'),
  ('21000000-0000-4000-8000-0000000000c2', '21000000-0000-4000-8000-000000000002', 'B-groceries', 'expense');

insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, amount_cents) values
  ('21000000-0000-4000-8000-000000000101', '21000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-0000000000a1', '2026-01-10', 'A-salary', 'income', null, 300000),
  ('21000000-0000-4000-8000-000000000102', '21000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-0000000000a1', '2026-01-12', 'A-shop', 'expense', '21000000-0000-4000-8000-0000000000c1', -45000);

insert into public.budgets (id, user_id, category_id, period, limit_cents) values
  ('21000000-0000-4000-8000-000000000201', '21000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-0000000000c1', '2026-01', 60000);

insert into public.monthly_plans (id, user_id, period, expected_income_cents) values
  ('21000000-0000-4000-8000-000000000301', '21000000-0000-4000-8000-000000000001', '2026-01', 400000),
  ('21000000-0000-4000-8000-000000000302', '21000000-0000-4000-8000-000000000001', '2026-02', 410000),
  ('21000000-0000-4000-8000-000000000309', '21000000-0000-4000-8000-000000000002', '2026-01', 999000);

-- ============================================================
-- 1. Owner isolation
-- ============================================================

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '21000000-0000-4000-8000-000000000001';

select is((select auth.uid()), '21000000-0000-4000-8000-000000000001'::uuid, 'the claim took effect');

select is(
  (select count(*)::int from public.monthly_plans),
  2,
  'owner A sees exactly their own two plans'
);
select is(
  (select count(*)::int from public.monthly_plans
   where id = '21000000-0000-4000-8000-000000000309'),
  0,
  'owner B''s plan is invisible to A -- not merely unwritable'
);

-- An UPDATE whose target fails USING matches zero rows rather than raising, so
-- this is proved by re-reading rather than by the absence of a throw.
select lives_ok(
  $$ update public.monthly_plans set expected_income_cents = 1
     where id = '21000000-0000-4000-8000-000000000309' $$,
  'updating another owner''s plan raises nothing (RLS filters, it does not error)'
);
select lives_ok(
  $$ delete from public.monthly_plans where id = '21000000-0000-4000-8000-000000000309' $$,
  'deleting another owner''s plan raises nothing either'
);

select throws_ok(
  $$ insert into public.monthly_plans (id, user_id, period, expected_income_cents)
     values ('21000000-0000-4000-8000-00000000030a', '21000000-0000-4000-8000-000000000002', '2026-03', 100) $$,
  '42501', null,
  'owner A cannot create a plan owned by B -- the INSERT policy''s WITH CHECK'
);

-- ============================================================
-- 2. Month isolation, and the shape of a plan
-- ============================================================

select is(
  (select expected_income_cents from public.monthly_plans
   where user_id = '21000000-0000-4000-8000-000000000001' and period = '2026-01'),
  400000::bigint,
  'January''s plan is January''s'
);
select is(
  (select expected_income_cents from public.monthly_plans
   where user_id = '21000000-0000-4000-8000-000000000001' and period = '2026-02'),
  410000::bigint,
  'February''s is a separate row with its own figure'
);

select throws_ok(
  $$ insert into public.monthly_plans (id, user_id, period, expected_income_cents)
     values ('21000000-0000-4000-8000-00000000030b', '21000000-0000-4000-8000-000000000001', '2026-01', 500000) $$,
  '23505', null,
  'a second plan for the same owner and month is refused -- one target per month'
);

select throws_ok(
  $$ update public.monthly_plans set period = '2026-03'
     where id = '21000000-0000-4000-8000-000000000301' $$,
  '42501', null,
  'a plan''s month cannot be rewritten -- period is INSERT-only at the grant layer'
);

select lives_ok(
  $$ update public.monthly_plans set expected_income_cents = 425000
     where id = '21000000-0000-4000-8000-000000000301' $$,
  'the expected figure itself is editable'
);
select is(
  (select expected_income_cents from public.monthly_plans
   where id = '21000000-0000-4000-8000-000000000301'),
  425000::bigint,
  'and the edit landed'
);

select lives_ok(
  $$ insert into public.monthly_plans (id, user_id, period, expected_income_cents)
     values ('21000000-0000-4000-8000-00000000030c', '21000000-0000-4000-8000-000000000001', '2026-03', 0) $$,
  'zero is a legal plan -- "I expect no income this month" is a real answer'
);

select throws_ok(
  $$ insert into public.monthly_plans (id, user_id, period, expected_income_cents)
     values ('21000000-0000-4000-8000-00000000030d', '21000000-0000-4000-8000-000000000001', '2026-04', -1) $$,
  '23514', null,
  'a negative expected income is refused -- an expectation has no direction'
);

select throws_ok(
  $$ insert into public.monthly_plans (id, user_id, period, expected_income_cents)
     values ('21000000-0000-4000-8000-00000000030e', '21000000-0000-4000-8000-000000000001', '2026-13', 100) $$,
  '23514', null,
  'a malformed period is refused by the same CHECK budgets.period uses'
);

-- Clearing is how a month returns to "not set", which is a state neither zero
-- nor an edit can express.
select lives_ok(
  $$ delete from public.monthly_plans where id = '21000000-0000-4000-8000-00000000030c' $$,
  'a plan can be cleared'
);
select is(
  (select count(*)::int from public.monthly_plans
   where user_id = '21000000-0000-4000-8000-000000000001' and period = '2026-03'),
  0,
  'and the month has no row at all afterwards -- not a zero'
);

-- ============================================================
-- 3. A target is not money
-- ============================================================
-- Nothing derived from transactions or accounts can see this table, so a plan
-- cannot influence a balance, a total or a snapshot even by accident. The
-- application-level counterpart is tests/mutations/monthly-plans.test.ts,
-- which reads every figure back through the production DAL.

select is(
  (select balance_cents from public.account_balances
   where id = '21000000-0000-4000-8000-0000000000a1'),
  (250000 + 300000 - 45000)::bigint,
  'the account balance is opening + ledger, with no term for an expected figure'
);

select is(
  (select count(*)::int from public.transactions
   where user_id = '21000000-0000-4000-8000-000000000001'),
  2,
  'writing plans created no transaction'
);

select is(
  (select count(*)::int from public.net_worth_snapshots
   where user_id = '21000000-0000-4000-8000-000000000001'),
  0,
  'and no net-worth snapshot'
);

select is(
  (select limit_cents from public.budgets where id = '21000000-0000-4000-8000-000000000201'),
  60000::bigint,
  'and left the category budget exactly as it was'
);

-- The structural statement of the same thing: `monthly_plans` is referenced by
-- no foreign key anywhere in this schema, so no row of any other table can
-- depend on a target.
select is(
  (select count(*)::int
   from pg_constraint c
   where c.contype = 'f'
     and c.confrelid = 'public.monthly_plans'::regclass),
  0,
  'no table in this schema references monthly_plans -- a target is nothing''s parent'
);

-- And it references nothing but `profiles`, so a plan cannot be pointed at an
-- account, a category or a transaction either.
select is(
  (select string_agg(c.confrelid::regclass::text, ',' order by c.confrelid::regclass::text)
   from pg_constraint c
   where c.contype = 'f'
     and c.conrelid = 'public.monthly_plans'::regclass),
  'profiles',
  'and references only profiles -- no account, no category, no ledger row'
);

-- ============================================================
-- Owner B sees their own, unchanged by everything above
-- ============================================================

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '21000000-0000-4000-8000-000000000002';

select is(
  (select expected_income_cents from public.monthly_plans
   where id = '21000000-0000-4000-8000-000000000309'),
  999000::bigint,
  'owner B''s plan survived A''s update and delete attempts untouched'
);
select is(
  (select count(*)::int from public.monthly_plans),
  1,
  'and B sees exactly one plan -- their own'
);

reset role;

select * from finish();
rollback;
