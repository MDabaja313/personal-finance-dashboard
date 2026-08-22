-- Timezone validation, the bill-occurrence deletion guard, and the
-- decisive whole-user teardown test that proves D10 rather than
-- assuming it.
begin;
select plan(15);

insert into auth.users (id, aud, role, email) values
  ('13000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'trig-test@local.test');
insert into public.profiles (id) values ('13000000-0000-4000-8000-000000000001');

-- ============================================================
-- Timezone validation (approach A): exercised under the privileged
-- test role (no authenticated UPDATE grant exists on profiles through
-- Phase 6, so an authenticated write would fail at the GRANT layer
-- before ever reaching the trigger); separately confirm the function
-- itself is SECURITY INVOKER (also asserted in 000-objects.sql,
-- repeated here for this file's self-containment).
-- ============================================================

savepoint tz1;
select lives_ok(
  $$ update public.profiles set timezone = 'America/New_York' where id = '13000000-0000-4000-8000-000000000001' $$,
  'a valid IANA timezone is accepted'
);
rollback to savepoint tz1;

savepoint tz2;
select throws_ok(
  $$ update public.profiles set timezone = 'Not/AZone' where id = '13000000-0000-4000-8000-000000000001' $$,
  null, null,
  'an invalid timezone is rejected'
);
rollback to savepoint tz2;

select is(
  (select prosecdef from pg_proc where oid = 'public.validate_profile_timezone()'::regprocedure),
  false,
  'validate_profile_timezone is SECURITY INVOKER, not SECURITY DEFINER'
);

-- ============================================================
-- Bill occurrence deletion guard
-- ============================================================

insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date) values
  ('13000000-0000-4000-8000-0000000000b1', '13000000-0000-4000-8000-000000000001', 'Bill', 100, 'monthly', '2026-01-01');
insert into public.bill_occurrences (id, user_id, bill_id, due_date, status, amount_cents, paid_on) values
  ('13000000-0000-4000-8000-00000000f001', '13000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000b1', '2026-01-01', 'scheduled', 100, null),
  ('13000000-0000-4000-8000-00000000f002', '13000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000b1', '2026-02-01', 'paid', 100, '2026-02-01'),
  ('13000000-0000-4000-8000-00000000f003', '13000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000b1', '2026-03-01', 'skipped', 100, null);

savepoint dg1;
select lives_ok(
  $$ delete from public.bill_occurrences where id = '13000000-0000-4000-8000-00000000f001' $$,
  'a direct delete of a scheduled occurrence is allowed'
);
rollback to savepoint dg1;

savepoint dg2;
select throws_ok(
  $$ delete from public.bill_occurrences where id = '13000000-0000-4000-8000-00000000f002' $$,
  null, null,
  'a direct delete of a paid occurrence is rejected'
);
rollback to savepoint dg2;

savepoint dg3;
select throws_ok(
  $$ delete from public.bill_occurrences where id = '13000000-0000-4000-8000-00000000f003' $$,
  null, null,
  'a direct delete of a skipped occurrence is rejected'
);
rollback to savepoint dg3;

-- ============================================================
-- Whole-user teardown: deleting auth.users must cascade the ENTIRE
-- graph -- including paid/skipped bill occurrences, a movement + its
-- two legs, and a goal + its contributions -- proving D10 rather than
-- assuming it.
-- ============================================================

savepoint teardown;

insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('13000000-0000-4000-8000-0000000000a1', '13000000-0000-4000-8000-000000000001', 'A1', 'Bank', 'checking', 0),
  ('13000000-0000-4000-8000-0000000000a2', '13000000-0000-4000-8000-000000000001', 'A2', 'Bank', 'savings', 0);
insert into public.movements (id, user_id, kind) values
  ('13000000-0000-4000-8000-0000000000d1', '13000000-0000-4000-8000-000000000001', 'transfer');
insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values
  ('13000000-0000-4000-8000-00000000f004', '13000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000a1', '2026-01-01', 'out', 'transfer', '13000000-0000-4000-8000-0000000000d1', -100),
  ('13000000-0000-4000-8000-00000000f005', '13000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-0000000000a2', '2026-01-01', 'in', 'transfer', '13000000-0000-4000-8000-0000000000d1', 100);
insert into public.goals (id, user_id, name, target_cents) values
  ('13000000-0000-4000-8000-00000000f006', '13000000-0000-4000-8000-000000000001', 'Goal', 1000);
insert into public.goal_contributions (id, user_id, goal_id, amount_cents, occurred_on) values
  ('13000000-0000-4000-8000-00000000f007', '13000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-00000000f006', 500, '2026-01-01');
-- The movement is balanced, so make sure it's valid before the teardown
-- exercises anything else -- an already-broken movement would make the
-- teardown result ambiguous.
select lives_ok(
  $$ set constraints all immediate $$,
  'the teardown fixture''s own movement is valid before deletion is attempted'
);
set constraints all deferred;

select is(
  (select count(*)::int from public.bill_occurrences where user_id = '13000000-0000-4000-8000-000000000001' and status in ('paid', 'skipped')),
  2,
  'the teardown user has both a paid and a skipped occurrence before teardown'
);

select lives_ok(
  $$ delete from auth.users where id = '13000000-0000-4000-8000-000000000001' $$,
  'deleting the user cascades the entire graph, including paid/skipped occurrences, and succeeds'
);

select is((select count(*)::int from public.profiles where id = '13000000-0000-4000-8000-000000000001'), 0, 'profile gone');
select is((select count(*)::int from public.accounts where user_id = '13000000-0000-4000-8000-000000000001'), 0, 'accounts gone');
select is((select count(*)::int from public.transactions where user_id = '13000000-0000-4000-8000-000000000001'), 0, 'transactions gone');
select is((select count(*)::int from public.movements where user_id = '13000000-0000-4000-8000-000000000001'), 0, 'movements gone');
select is((select count(*)::int from public.goal_contributions where user_id = '13000000-0000-4000-8000-000000000001'), 0, 'goal contributions gone');
select is((select count(*)::int from public.bill_occurrences where user_id = '13000000-0000-4000-8000-000000000001'), 0, 'bill occurrences (incl. paid/skipped) gone');

rollback to savepoint teardown;
set constraints all deferred;

-- No finish() -- see 020-movements.sql.
rollback;
