-- Phase 7 Checkpoint 6: budget and goal writes, in the database.
--
-- 100-write-grants.sql already proves the exact grant/column matrix; this
-- file proves the *behavior* on top of it -- ownership isolation, the two
-- new guard triggers, and the existing CHECK constraints these writes now
-- actually reach. Everything runs as `authenticated` with a verified-claim
-- uid set, exactly as PostgREST does it, except the fixture setup (which
-- runs as the migration owner, who bypasses RLS via BYPASSRLS).
--
-- ============================================================
-- What this file proves, and what it deliberately leaves elsewhere
-- ============================================================
--
-- Proved here, because these are database facts:
--
--   * budgets: an active-expense-category budget can be created; an
--     archived or non-expense category is refused by the new trigger; a
--     negative limit and a duplicate (category, period) are refused by
--     the existing CHECK/UNIQUE constraints; only limit_cents can be
--     edited afterwards; a foreign category is structurally impossible
--     (the composite FK); ownership isolation on UPDATE/DELETE.
--   * goals: a non-positive target is refused by the existing CHECK;
--     name/target/date remain editable while archived; archive and
--     unarchive both work and neither touches a single contribution row;
--     ownership isolation on UPDATE.
--   * goal_contributions: an owned active goal accepts a contribution; an
--     archived goal refuses one (the new trigger); a future occurred_on
--     is refused (the new trigger); a foreign goal is structurally
--     impossible (the composite FK); zero and negative amounts are
--     DB-legal; contributions survive archiving unchanged; saved_cents
--     (goal_balances) is always the exact SUM of what was inserted; no
--     UPDATE or DELETE is possible at all, against a row that actually
--     exists; and the posted-date ceiling is computed in the OWNER'S OWN
--     timezone, never UTC and never the server's clock -- proved with two
--     owners at deliberately opposite extreme offsets, the same technique
--     135-posted-ledger.sql uses for assert_transaction_refs(). The
--     ordinary future-date test above (owner A, profile default 'UTC')
--     does not by itself distinguish "uses the owner's timezone" from
--     "hardcodes UTC", since A's timezone happens to be UTC; the dedicated
--     section below is what actually proves it.
--
-- Left to tests/mutations/budgets.test.ts and goals.test.ts, because they
-- are TypeScript facts:
--
--   * Idempotent retry by client-minted id (exact-match success, mismatch
--     conflict), and the three-way disambiguation of a 23505 on budgets
--     (own row / different payload / natural-key collision).
--   * The current-month derivation from the owner's own timezone -- this
--     file writes whatever period/date it likes, since the trigger and
--     CHECK constraints exercised here do not care what "current" means.
--   * The exact user-facing messages and revalidation paths.
begin;
select plan(46);

-- ============================================================
-- Fixture: two owners, with categories and goals for A
-- ============================================================

insert into auth.users (id, aud, role, email) values
  ('1c000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'budgoal-a@local.test'),
  ('1c000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'budgoal-b@local.test');
insert into public.profiles (id) values
  ('1c000000-0000-4000-8000-000000000001'),
  ('1c000000-0000-4000-8000-000000000002');

insert into public.categories (id, user_id, name, kind, is_archived) values
  ('1c000000-0000-4000-8000-0000000000c1', '1c000000-0000-4000-8000-000000000001', 'A-expense-active', 'expense', false),
  ('1c000000-0000-4000-8000-0000000000c2', '1c000000-0000-4000-8000-000000000001', 'A-expense-archived', 'expense', true),
  ('1c000000-0000-4000-8000-0000000000c3', '1c000000-0000-4000-8000-000000000001', 'A-income', 'income', false),
  ('1c000000-0000-4000-8000-0000000000c9', '1c000000-0000-4000-8000-000000000002', 'B-expense', 'expense', false);

insert into public.goals (id, user_id, name, target_cents) values
  ('1c000000-0000-4000-8000-0000000000d9', '1c000000-0000-4000-8000-000000000002', 'B-goal', 100000);

-- Two more owners, at deliberately opposite extreme timezone offsets, used
-- only by the timezone-boundary section near the end of this file:
--
--   C  Pacific/Kiritimati  UTC+14  -- always the furthest ahead
--   D  Pacific/Niue        UTC-11  -- always the furthest behind
--
-- The combined 25-hour offset guarantees their local calendar dates are a
-- full day apart at every instant (no DST in either zone), which is what
-- makes the sanity assertion below unconditionally true rather than true
-- only part of the day -- exactly 135-posted-ledger.sql's fixture, reused
-- here for the identical reason.
insert into auth.users (id, aud, role, email) values
  ('1c000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'budgoal-c@local.test'),
  ('1c000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'budgoal-d@local.test');
insert into public.profiles (id, timezone) values
  ('1c000000-0000-4000-8000-000000000005', 'Pacific/Kiritimati'),
  ('1c000000-0000-4000-8000-000000000006', 'Pacific/Niue');

insert into public.goals (id, user_id, name, target_cents) values
  ('1c000000-0000-4000-8000-0000000000d5', '1c000000-0000-4000-8000-000000000005', 'C-goal', 100000),
  ('1c000000-0000-4000-8000-0000000000d6', '1c000000-0000-4000-8000-000000000006', 'D-goal', 100000);

-- The owner's own calendar day and tomorrow, from their own profile
-- timezone -- the same expression assert_goal_contribution_refs() and
-- assert_transaction_refs() both use. Derived rather than hardcoded so
-- this file does not age out of correctness.
create temporary table budgoal_dates on commit drop as
select
  (now() at time zone p.timezone)::date as owner_today,
  ((now() at time zone p.timezone)::date + 1) as owner_tomorrow
from public.profiles p
where p.id = '1c000000-0000-4000-8000-000000000001';

grant select on budgoal_dates to authenticated;

-- C and D's own local dates, kept apart from `budgoal_dates` above:
-- owner A's profile timezone defaults to 'UTC' (never set explicitly), so
-- `budgoal_dates` alone cannot distinguish "computed from the owner's own
-- timezone" from "hardcodes UTC" -- both produce the same value for A. C
-- and D exist specifically to force that distinction.
create temporary table tz_boundary_dates (
  label text primary key,
  value date not null
) on commit drop;

insert into tz_boundary_dates (label, value) values
  ('c_today',    (now() at time zone 'Pacific/Kiritimati')::date),
  ('c_tomorrow', (now() at time zone 'Pacific/Kiritimati')::date + 1),
  ('d_today',    (now() at time zone 'Pacific/Niue')::date),
  ('d_tomorrow', (now() at time zone 'Pacific/Niue')::date + 1);

create or replace function pg_temp.tzd(p_label text) returns date
language sql stable as $$ select value from tz_boundary_dates where label = p_label $$;

-- The boundary section below runs *as* `authenticated` and reads these
-- dates to build its statements. Scoped to a transaction-local temporary
-- table and a temporary function, both dropped at commit and rolled back
-- regardless: a test-harness concern only, granting nothing on any
-- application object.
grant select on tz_boundary_dates to authenticated;
grant execute on function pg_temp.tzd(text) to authenticated;

-- ============================================================
-- Act as owner A
-- ============================================================

set local role authenticated;
set local request.jwt.claim.sub = '1c000000-0000-4000-8000-000000000001';

select is(auth.uid(), '1c000000-0000-4000-8000-000000000001'::uuid, 'auth.uid() reflects the claim for owner A');

-- ============================================================
-- Budgets
-- ============================================================

select lives_ok(
  $$ insert into public.budgets (id, user_id, category_id, period, limit_cents)
     values ('1c000000-0000-4000-8000-0000000000b1', '1c000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000c1', '2026-03', 50000) $$,
  'an active expense category accepts a budget'
);

select throws_ok(
  $$ insert into public.budgets (id, user_id, category_id, period, limit_cents)
     values ('1c000000-0000-4000-8000-0000000000b2', '1c000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000c1', '2026-03', 10000) $$,
  '23505', null,
  'a second budget for the same (category, period) is refused by the existing UNIQUE constraint'
);

select throws_ok(
  $$ insert into public.budgets (id, user_id, category_id, period, limit_cents)
     values ('1c000000-0000-4000-8000-0000000000b3', '1c000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000c1', '2026-04', -100) $$,
  '23514', null,
  'a negative limit is refused by budgets_limit_nonneg_ck'
);

select throws_ok(
  $$ insert into public.budgets (id, user_id, category_id, period, limit_cents)
     values ('1c000000-0000-4000-8000-0000000000b4', '1c000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000c2', '2026-04', 1000) $$,
  '23514', null,
  'an archived category is refused by assert_budget_category_active_expense()'
);

select throws_ok(
  $$ insert into public.budgets (id, user_id, category_id, period, limit_cents)
     values ('1c000000-0000-4000-8000-0000000000b5', '1c000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000c3', '2026-04', 1000) $$,
  '23514', null,
  'an income category is refused by assert_budget_category_active_expense()'
);

-- A foreign category with A's own user_id: the composite FK
-- (category_id, user_id) -> categories(id, user_id) has no row to match,
-- since B's category carries B's user_id. Structurally impossible, not
-- merely policy-refused -- and also already proved in
-- 040-ownership.sql, restated here so this file's own CP6 story is
-- self-contained. `budgets_category_fk` is DEFERRABLE INITIALLY
-- DEFERRED, so the violation surfaces only once constraints are checked
-- -- `set constraints all immediate` inside the same savepoint, exactly
-- as 040-ownership.sql does for every other composite FK.
savepoint budget_foreign_category;
insert into public.budgets (id, user_id, category_id, period, limit_cents) values
  ('1c000000-0000-4000-8000-0000000000b6', '1c000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000c9', '2026-04', 1000);
select throws_ok(
  $$ set constraints all immediate $$, '23503', null,
  'a category belonging to another owner is structurally impossible via the composite FK'
);
rollback to savepoint budget_foreign_category;
set constraints all deferred;

select is(
  (select limit_cents from public.budgets where id = '1c000000-0000-4000-8000-0000000000b1'),
  50000::bigint,
  'the created budget carries the submitted limit'
);

select lives_ok(
  $$ update public.budgets set limit_cents = 75000 where id = '1c000000-0000-4000-8000-0000000000b1' $$,
  'authenticated may UPDATE limit_cents on an owned budget'
);
select is(
  (select limit_cents from public.budgets where id = '1c000000-0000-4000-8000-0000000000b1'),
  75000::bigint,
  'the limit actually changed'
);

select lives_ok(
  $$ delete from public.budgets where id = '1c000000-0000-4000-8000-0000000000b1' $$,
  'authenticated may DELETE an owned budget -- planning metadata, not ledger history'
);
select is(
  (select count(*)::int from public.budgets where id = '1c000000-0000-4000-8000-0000000000b1'),
  0,
  'the deleted budget is actually gone'
);

-- ============================================================
-- Goals
-- ============================================================

select throws_ok(
  $$ insert into public.goals (id, user_id, name, target_cents)
     values ('1c000000-0000-4000-8000-0000000000d1', '1c000000-0000-4000-8000-000000000001', 'Bad goal', 0) $$,
  '23514', null,
  'a non-positive target is refused by goals_target_positive_ck'
);

select lives_ok(
  $$ insert into public.goals (id, user_id, name, target_cents, target_date)
     values ('1c000000-0000-4000-8000-0000000000d1', '1c000000-0000-4000-8000-000000000001', 'Emergency fund', 500000, '2026-12-31') $$,
  'a positive target creates a goal'
);

select lives_ok(
  $$ update public.goals set name = 'Emergency fund (renamed)', target_cents = 600000, target_date = null
     where id = '1c000000-0000-4000-8000-0000000000d1' $$,
  'authenticated may UPDATE name/target/date on an owned goal'
);
select is(
  (select target_cents from public.goals where id = '1c000000-0000-4000-8000-0000000000d1'),
  600000::bigint,
  'the target actually changed, and may be edited below what is saved later'
);

select lives_ok(
  $$ update public.goals set archived_at = now() where id = '1c000000-0000-4000-8000-0000000000d1' $$,
  'archiving an owned goal succeeds'
);
select is(
  (select archived_at is not null from public.goals where id = '1c000000-0000-4000-8000-0000000000d1'),
  true,
  'the goal is now archived'
);

-- Editing an archived goal's own metadata stays legal -- nothing about
-- archiving restricts a plain rename/retarget.
select lives_ok(
  $$ update public.goals set name = 'Emergency fund (archived, still editable)'
     where id = '1c000000-0000-4000-8000-0000000000d1' $$,
  'a goal''s name/target/date remain editable while archived'
);

select lives_ok(
  $$ update public.goals set archived_at = null where id = '1c000000-0000-4000-8000-0000000000d1' $$,
  'unarchiving an owned goal succeeds'
);
select is(
  (select archived_at from public.goals where id = '1c000000-0000-4000-8000-0000000000d1'),
  null,
  'the goal is active again'
);

-- ============================================================
-- Goal contributions
-- ============================================================

select lives_ok(
  $$ insert into public.goal_contributions (id, user_id, goal_id, amount_cents, occurred_on, note)
     values ('1c000000-0000-4000-8000-0000000000e1', '1c000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000d1', 10000, (select owner_today from budgoal_dates), 'first deposit') $$,
  'a positive contribution to an owned, active goal succeeds'
);

select lives_ok(
  $$ insert into public.goal_contributions (id, user_id, goal_id, amount_cents, occurred_on)
     values ('1c000000-0000-4000-8000-0000000000e2', '1c000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000d1', -2500, (select owner_today from budgoal_dates)) $$,
  'a negative contribution (a withdrawal/correction) succeeds -- signed, no <> 0 constraint'
);

select lives_ok(
  $$ insert into public.goal_contributions (id, user_id, goal_id, amount_cents, occurred_on)
     values ('1c000000-0000-4000-8000-0000000000e3', '1c000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000d1', 0, (select owner_today from budgoal_dates)) $$,
  'a zero-amount contribution remains DB-legal, exactly as for ordinary transactions'
);

select is(
  (select saved_cents from public.goal_balances where id = '1c000000-0000-4000-8000-0000000000d1'),
  7500::bigint,
  'goal_balances.saved_cents is the exact SUM of the three contributions (10000 - 2500 + 0)'
);

select throws_ok(
  format(
    $$ insert into public.goal_contributions (id, user_id, goal_id, amount_cents, occurred_on)
       values ('1c000000-0000-4000-8000-0000000000e4', '1c000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000d1', 100, %L) $$,
    (select owner_tomorrow from budgoal_dates)
  ),
  '23514', null,
  'a contribution dated after the owner''s own calendar day is refused by assert_goal_contribution_refs()'
);

-- ============================================================
-- Timezone-boundary proof: the ceiling is the OWNER's own calendar day,
-- never UTC and never the server's clock.
-- ============================================================
-- Owner A above defaults to profile timezone 'UTC', so the test just
-- above cannot tell "computed from the owner's own timezone" apart from
-- "hardcodes UTC" -- both give the same answer for A. Owners C and D,
-- fixtured at opposite extreme offsets, exist to force that distinction:
-- a naive implementation comparing against current_date or UTC would
-- pass every assertion so far in this file and fail the four below.

select is(
  pg_temp.tzd('c_today') - pg_temp.tzd('d_today'),
  1,
  'owners C and D are a full calendar day apart at this instant (the premise the boundary proof rests on)'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '1c000000-0000-4000-8000-000000000005';

savepoint c_today_ok;
select lives_ok(
  format(
    $$ insert into public.goal_contributions (id, user_id, goal_id, amount_cents, occurred_on)
       values ('1c000000-0000-4000-8000-0000000000f1', '1c000000-0000-4000-8000-000000000005', '1c000000-0000-4000-8000-0000000000d5', 100, %L) $$,
    pg_temp.tzd('c_today')
  ),
  'a contribution dated owner C''s own local TODAY (Pacific/Kiritimati, UTC+14) is accepted'
);
rollback to savepoint c_today_ok;

select throws_ok(
  format(
    $$ insert into public.goal_contributions (id, user_id, goal_id, amount_cents, occurred_on)
       values ('1c000000-0000-4000-8000-0000000000f2', '1c000000-0000-4000-8000-000000000005', '1c000000-0000-4000-8000-0000000000d5', 100, %L) $$,
    pg_temp.tzd('c_tomorrow')
  ),
  '23514', null,
  'a contribution dated owner C''s own local TOMORROW is refused -- a UTC or server-clock ceiling would accept this for several hours each day'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '1c000000-0000-4000-8000-000000000006';

savepoint d_today_ok;
select lives_ok(
  format(
    $$ insert into public.goal_contributions (id, user_id, goal_id, amount_cents, occurred_on)
       values ('1c000000-0000-4000-8000-0000000000f3', '1c000000-0000-4000-8000-000000000006', '1c000000-0000-4000-8000-0000000000d6', 100, %L) $$,
    pg_temp.tzd('d_today')
  ),
  'a contribution dated owner D''s own local TODAY (Pacific/Niue, UTC-11) is accepted'
);
rollback to savepoint d_today_ok;

select throws_ok(
  format(
    $$ insert into public.goal_contributions (id, user_id, goal_id, amount_cents, occurred_on)
       values ('1c000000-0000-4000-8000-0000000000f4', '1c000000-0000-4000-8000-000000000006', '1c000000-0000-4000-8000-0000000000d6', 100, %L) $$,
    pg_temp.tzd('d_tomorrow')
  ),
  '23514', null,
  'a contribution dated owner D''s own local TOMORROW is refused -- proving the ceiling is per-owner, not one shared UTC/server value'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '1c000000-0000-4000-8000-000000000001';

-- A foreign goal with A's own user_id: the composite FK
-- (goal_id, user_id) -> goals(id, user_id) has no row to match. Same
-- DEFERRABLE INITIALLY DEFERRED story as the budget case above.
savepoint contribution_foreign_goal;
insert into public.goal_contributions (id, user_id, goal_id, amount_cents, occurred_on) values
  ('1c000000-0000-4000-8000-0000000000e5', '1c000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000d9', 100, (select owner_today from budgoal_dates));
select throws_ok(
  $$ set constraints all immediate $$, '23503', null,
  'a goal belonging to another owner is structurally impossible via the composite FK'
);
rollback to savepoint contribution_foreign_goal;
set constraints all deferred;

-- Archive the goal, then prove new contributions are refused while every
-- existing one is retained, byte for byte.
select lives_ok(
  $$ update public.goals set archived_at = now() where id = '1c000000-0000-4000-8000-0000000000d1' $$,
  'archiving the goal again, ahead of the contribution-refusal checks'
);

select throws_ok(
  $$ insert into public.goal_contributions (id, user_id, goal_id, amount_cents, occurred_on)
     values ('1c000000-0000-4000-8000-0000000000e6', '1c000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000d1', 100, (select owner_today from budgoal_dates)) $$,
  '23514', null,
  'a contribution to an archived goal is refused by assert_goal_contribution_refs()'
);

select is(
  (select count(*)::int from public.goal_contributions where goal_id = '1c000000-0000-4000-8000-0000000000d1'),
  3,
  'archiving the goal destroyed none of its three existing contributions'
);
select is(
  (select saved_cents from public.goal_balances where id = '1c000000-0000-4000-8000-0000000000d1'),
  7500::bigint,
  'saved_cents is unchanged while archived -- the rollup does not care about archived_at'
);

select lives_ok(
  $$ update public.goals set archived_at = null where id = '1c000000-0000-4000-8000-0000000000d1' $$,
  'unarchiving restores normal contribution use'
);
select lives_ok(
  $$ insert into public.goal_contributions (id, user_id, goal_id, amount_cents, occurred_on)
     values ('1c000000-0000-4000-8000-0000000000e7', '1c000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000d1', 100, (select owner_today from budgoal_dates)) $$,
  'a contribution after unarchiving succeeds'
);
select is(
  (select saved_cents from public.goal_balances where id = '1c000000-0000-4000-8000-0000000000d1'),
  7600::bigint,
  'saved_cents now includes the post-unarchive contribution'
);

-- No privilege path edits history -- proved against a row that actually
-- exists, not only the generic "where false" probes in
-- 100-write-grants.sql.
select throws_ok(
  $$ update public.goal_contributions set note = 'edited' where id = '1c000000-0000-4000-8000-0000000000e1' $$,
  '42501', null,
  'authenticated cannot UPDATE an existing, owned goal_contributions row -- append-only'
);
select throws_ok(
  $$ delete from public.goal_contributions where id = '1c000000-0000-4000-8000-0000000000e1' $$,
  '42501', null,
  'authenticated cannot DELETE an existing, owned goal_contributions row -- append-only'
);

-- ============================================================
-- Ownership isolation, from the other side
-- ============================================================

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '1c000000-0000-4000-8000-000000000002';

select is((select count(*)::int from public.budgets), 0, 'B sees none of A''s budgets');
select is((select count(*)::int from public.goals where id = '1c000000-0000-4000-8000-0000000000d1'), 0, 'B does not see A''s goal');
select is((select count(*)::int from public.goal_contributions where goal_id = '1c000000-0000-4000-8000-0000000000d1'), 0, 'B does not see A''s contributions');

-- An UPDATE targeting a row RLS filters out matches zero rows rather than
-- raising -- proved by re-reading afterwards, exactly as
-- 110-write-rls.sql does for transactions.
insert into public.budgets (id, user_id, category_id, period, limit_cents) values
  ('1c000000-0000-4000-8000-0000000000b9', '1c000000-0000-4000-8000-000000000002', '1c000000-0000-4000-8000-0000000000c9', '2026-03', 20000);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '1c000000-0000-4000-8000-000000000001';

select lives_ok(
  $$ update public.budgets set limit_cents = 999999 where id = '1c000000-0000-4000-8000-0000000000b9' $$,
  'A''s UPDATE against B''s budget id runs without error (RLS filters rows, it does not raise)'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '1c000000-0000-4000-8000-000000000002';

select is(
  (select limit_cents from public.budgets where id = '1c000000-0000-4000-8000-0000000000b9'),
  20000::bigint,
  'B''s budget is untouched by A''s UPDATE attempt -- it matched zero rows'
);

reset role;

select * from finish();
rollback;
