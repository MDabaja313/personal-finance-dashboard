-- assert_transaction_refs(): the posted-ledger invariants.
--
-- 100/110 cover *privileges* and *rows* -- which operations exist and
-- which rows they can reach. This file covers the four cross-row rules
-- no GRANT, CHECK or policy can express, plus the two CHECK constraints
-- that landed with them:
--
--   1. No posted row may be dated later than the OWNER'S current
--      calendar day.
--   2. The account may not be archived.
--   3. A category, when present, must be active and must match the
--      transaction's kind.
--   4. An adjustment carries no category.
--
-- Rule 1 is the one with a trap in it, and the timezone section below
-- exists specifically to fall into it: an implementation that compares
-- against the *server's* UTC date passes every other assertion in this
-- file and fails those. That is deliberate -- a UTC ceiling would reject
-- a transaction an owner in Auckland is entering right now, on the date
-- their own calendar shows, and would accept one dated tomorrow for an
-- owner in Los Angeles for several hours each night.
--
-- Every date below is computed *relative to the fixture owner's own
-- timezone* rather than hardcoded, so this file does not rot: a suite
-- pinned to literal dates starts failing the day the literals age past
-- "today", which is exactly the kind of failure that gets a real
-- assertion deleted.
--
-- Fixture setup runs as the migration owner (postgres, BYPASSRLS), the
-- same arrangement 020/030/040/050/060/110 use. The trigger fires
-- regardless of role -- it is a BEFORE ROW trigger, not a policy -- which
-- is why most cases here can run as the owner and stay readable; the
-- section that specifically needs `authenticated` says so.
begin;
select plan(27);

-- ============================================================
-- Fixture
-- ============================================================
-- Two owners with deliberately opposite timezone offsets, so that at
-- every instant of the day at least one of them disagrees with UTC
-- about what "today" is:
--
--   PL-A  Pacific/Kiritimati  UTC+14  -- always the furthest ahead
--   PL-B  Pacific/Niue        UTC-11  -- always the furthest behind
--
-- Their local dates differ from each other by a full calendar day at
-- every instant, and each differs from UTC for part of the day. No DST
-- in either zone, so the offsets are fixed and the arithmetic below has
-- no seasonal edge case.

insert into auth.users (id, aud, role, email) values
  ('1b000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pl-a@local.test'),
  ('1b000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pl-b@local.test');

insert into public.profiles (id, timezone) values
  ('1b000000-0000-4000-8000-000000000001', 'Pacific/Kiritimati'),
  ('1b000000-0000-4000-8000-000000000002', 'Pacific/Niue');

insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('1b000000-0000-4000-8000-0000000000a1', '1b000000-0000-4000-8000-000000000001', 'A-acct', 'Bank', 'checking', 0),
  ('1b000000-0000-4000-8000-0000000000a2', '1b000000-0000-4000-8000-000000000001', 'A-acct-2', 'Bank', 'savings', 0),
  ('1b000000-0000-4000-8000-0000000000a9', '1b000000-0000-4000-8000-000000000001', 'A-archived', 'Bank', 'checking', 0),
  ('1b000000-0000-4000-8000-0000000000b1', '1b000000-0000-4000-8000-000000000002', 'B-acct', 'Bank', 'checking', 0);

-- Archived with a zero balance and no transactions, which is the only
-- state CP2's accounts_guard_update() permits archiving from.
update public.accounts set is_archived = true
  where id = '1b000000-0000-4000-8000-0000000000a9';

insert into public.categories (id, user_id, name, kind, is_archived) values
  ('1b000000-0000-4000-8000-0000000000c1', '1b000000-0000-4000-8000-000000000001', 'A-expense', 'expense', false),
  ('1b000000-0000-4000-8000-0000000000c2', '1b000000-0000-4000-8000-000000000001', 'A-income', 'income', false),
  ('1b000000-0000-4000-8000-0000000000c9', '1b000000-0000-4000-8000-000000000001', 'A-retired', 'expense', true);

-- The owners' own calendar days and their neighbours, as the trigger
-- computes them. Every assertion below reads from here rather than
-- hardcoding a literal.
create temporary table pl_dates (
  label text primary key,
  value date not null
) on commit drop;

insert into pl_dates (label, value) values
  ('a_today',    (now() at time zone 'Pacific/Kiritimati')::date),
  ('a_tomorrow', (now() at time zone 'Pacific/Kiritimati')::date + 1),
  ('a_yesterday',(now() at time zone 'Pacific/Kiritimati')::date - 1),
  ('b_today',    (now() at time zone 'Pacific/Niue')::date),
  ('utc_today',  (now() at time zone 'UTC')::date);

create or replace function pg_temp.d(p_label text) returns date
language sql stable as $$ select value from pl_dates where label = p_label $$;

-- The last section below runs *as* `authenticated` and reads these dates
-- to build its statements. Scoped to a transaction-local temporary table
-- and a temporary function, both dropped at commit and rolled back
-- regardless: a test-harness concern only, granting nothing on any
-- application object.
grant select on pl_dates to authenticated;
grant execute on function pg_temp.d(text) to authenticated;

-- ============================================================
-- Sanity: the fixture actually creates the disagreement it needs
-- ============================================================
-- Without this, every timezone assertion below could pass vacuously on
-- a machine or a build where the two zones happened to agree.

select is(
  pg_temp.d('a_today') - pg_temp.d('b_today'),
  1,
  'the two fixture owners are a full calendar day apart at this instant (the premise of the timezone cases)'
);

-- ============================================================
-- Rule 1: the posted-date ceiling, in the owner's timezone
-- ============================================================

savepoint today_ok;
select lives_ok(
  format(
    $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents)
       values ('1b000000-0000-4000-8000-000000000101', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', %L, 'today', 'expense', -100) $$,
    pg_temp.d('a_today')
  ),
  'a transaction dated the owner''s TODAY is accepted'
);
rollback to savepoint today_ok;

savepoint past_ok;
select lives_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents)
     values ('1b000000-0000-4000-8000-000000000102', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', '2020-03-01', 'long ago', 'expense', -100) $$,
  'a transaction dated years in the past is accepted -- there is no lower bound'
);
rollback to savepoint past_ok;

savepoint tomorrow_bad;
select throws_ok(
  format(
    $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents)
       values ('1b000000-0000-4000-8000-000000000103', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', %L, 'tomorrow', 'expense', -100) $$,
    pg_temp.d('a_tomorrow')
  ),
  '23514',
  null,
  'a transaction dated the owner''s TOMORROW is rejected -- this table is a ledger, not a plan'
);
rollback to savepoint tomorrow_bad;

-- UPDATE is covered too, not just INSERT. Without this an ordinary row
-- could be entered today and then walked into the future one edit later.
savepoint update_into_future;
insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents)
  values ('1b000000-0000-4000-8000-000000000104', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', '2020-03-01', 'x', 'expense', -100);
select throws_ok(
  format(
    $$ update public.transactions set date = %L where id = '1b000000-0000-4000-8000-000000000104' $$,
    pg_temp.d('a_tomorrow')
  ),
  '23514',
  null,
  'an UPDATE moving an existing row into the owner''s future is rejected'
);
select lives_ok(
  format(
    $$ update public.transactions set date = %L where id = '1b000000-0000-4000-8000-000000000104' $$,
    pg_temp.d('a_today')
  ),
  'an UPDATE moving that same row to the owner''s today is accepted'
);
rollback to savepoint update_into_future;

-- ============================================================
-- Rule 1, the timezone half: these FAIL against a UTC ceiling
-- ============================================================
-- Owner A is UTC+14 and owner B is UTC-11, so exactly one of the two
-- cases below is a real disagreement with UTC at any given instant, and
-- which one it is depends on the time of day. Both are asserted, so the
-- pair catches a UTC implementation around the clock rather than only
-- during the hours when one of them happens to differ.
--
--   * A's local today is UTC's today or tomorrow. When it is tomorrow, a
--     UTC ceiling rejects a row A is entering on A's own current date.
--   * B's local today is UTC's today or yesterday. When it is yesterday,
--     UTC's today is B's tomorrow, and a UTC ceiling accepts a row dated
--     in B's future.

savepoint tz_ahead;
select lives_ok(
  format(
    $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents)
       values ('1b000000-0000-4000-8000-000000000105', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', %L, 'A-local-today', 'expense', -100) $$,
    pg_temp.d('a_today')
  ),
  'UTC+14 owner: a row dated their own local today is accepted (a UTC ceiling rejects this for 14h a day)'
);
rollback to savepoint tz_ahead;

savepoint tz_behind;
select throws_ok(
  format(
    $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents)
       values ('1b000000-0000-4000-8000-000000000106', '1b000000-0000-4000-8000-000000000002', '1b000000-0000-4000-8000-0000000000b1', %L, 'A-local-today', 'expense', -100) $$,
    pg_temp.d('a_today')
  ),
  '23514',
  null,
  'UTC-11 owner: a row dated the UTC+14 owner''s today is rejected -- the ceiling is per-owner, not global'
);
rollback to savepoint tz_behind;

-- The ceiling really is read from the profile, not from a constant: move
-- the owner's timezone and the same date changes verdict.
savepoint tz_from_profile;
update public.profiles set timezone = 'Pacific/Niue'
  where id = '1b000000-0000-4000-8000-000000000001';
select throws_ok(
  format(
    $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents)
       values ('1b000000-0000-4000-8000-000000000107', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', %L, 'x', 'expense', -100) $$,
    pg_temp.d('a_today')
  ),
  '23514',
  null,
  'the ceiling follows profiles.timezone: the same date is refused once the owner is moved to UTC-11'
);
rollback to savepoint tz_from_profile;

-- ============================================================
-- Rule 2: the account may not be archived
-- ============================================================
-- Archiving requires a zero derived balance (accounts_guard_update), and
-- an archived account is excluded from net worth and from the
-- asset/liability totals -- so posting into one would create money that
-- exists in the ledger and in no summary.

savepoint archived_account;
select throws_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents)
     values ('1b000000-0000-4000-8000-000000000108', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a9', '2020-03-01', 'x', 'expense', -100) $$,
  '23514',
  null,
  'a transaction on an ARCHIVED account is rejected -- unarchive it first'
);
rollback to savepoint archived_account;

savepoint archived_account_update;
insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents)
  values ('1b000000-0000-4000-8000-000000000109', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', '2020-03-01', 'x', 'expense', -100);
select throws_ok(
  $$ update public.transactions set account_id = '1b000000-0000-4000-8000-0000000000a9'
     where id = '1b000000-0000-4000-8000-000000000109' $$,
  '23514',
  null,
  'moving an existing transaction ONTO an archived account is rejected'
);
select lives_ok(
  $$ update public.transactions set account_id = '1b000000-0000-4000-8000-0000000000a2'
     where id = '1b000000-0000-4000-8000-000000000109' $$,
  'moving it onto another ACTIVE account of the same owner is accepted'
);
rollback to savepoint archived_account_update;

-- A foreign account is not this trigger's business: the composite FK
-- (account_id, user_id) -> accounts (id, user_id) owns that case, and it
-- is DEFERRABLE, so the rejection is a 23503 at COMMIT. Asserted here so
-- a future edit to the trigger cannot quietly take the case over and
-- change its error code out from under 040-ownership.sql.
savepoint foreign_account;
insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents)
  values ('1b000000-0000-4000-8000-00000000010a', '1b000000-0000-4000-8000-000000000002', '1b000000-0000-4000-8000-0000000000a1', '2020-03-01', 'x', 'expense', -100);
select throws_ok(
  $$ set constraints all immediate $$, '23503', null,
  'a transaction on another owner''s account is still refused by the composite FK, not by this trigger'
);
rollback to savepoint foreign_account;
set constraints all deferred;

-- ============================================================
-- Rule 3: category must be active and kind-compatible
-- ============================================================

savepoint archived_category;
select throws_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, amount_cents)
     values ('1b000000-0000-4000-8000-00000000010b', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', '2020-03-01', 'x', 'expense', '1b000000-0000-4000-8000-0000000000c9', -100) $$,
  '23514',
  null,
  'a transaction using an ARCHIVED category is rejected'
);
rollback to savepoint archived_category;

savepoint kind_mismatch_expense;
select throws_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, amount_cents)
     values ('1b000000-0000-4000-8000-00000000010c', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', '2020-03-01', 'x', 'expense', '1b000000-0000-4000-8000-0000000000c2', -100) $$,
  '23514',
  null,
  'an expense filed against an INCOME category is rejected'
);
rollback to savepoint kind_mismatch_expense;

savepoint kind_mismatch_income;
select throws_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, amount_cents)
     values ('1b000000-0000-4000-8000-00000000010d', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', '2020-03-01', 'x', 'income', '1b000000-0000-4000-8000-0000000000c1', 100) $$,
  '23514',
  null,
  'income filed against an EXPENSE category is rejected'
);
rollback to savepoint kind_mismatch_income;

-- A refund takes an EXPENSE category, deliberately: it reduces that
-- category's spend rather than adding income.
savepoint refund_category;
select lives_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, amount_cents)
     values ('1b000000-0000-4000-8000-00000000010e', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', '2020-03-01', 'x', 'refund', '1b000000-0000-4000-8000-0000000000c1', 100) $$,
  'a refund against an EXPENSE category is accepted -- a refund is not income'
);
rollback to savepoint refund_category;

savepoint refund_income_category;
select throws_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, amount_cents)
     values ('1b000000-0000-4000-8000-00000000010f', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', '2020-03-01', 'x', 'refund', '1b000000-0000-4000-8000-0000000000c2', 100) $$,
  '23514',
  null,
  'a refund against an INCOME category is rejected'
);
rollback to savepoint refund_income_category;

-- The positive control the rest of this section depends on: an ordinary
-- row with a matching, active category is fine, and so is one with no
-- category at all. Uncategorized has always been legal in this schema
-- and this trigger does not change that.
savepoint valid_rows;
select lives_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, amount_cents)
     values ('1b000000-0000-4000-8000-000000000110', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', '2020-03-01', 'x', 'expense', '1b000000-0000-4000-8000-0000000000c1', -100) $$,
  'an expense against an active, matching category is accepted'
);
select lives_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents)
     values ('1b000000-0000-4000-8000-000000000111', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', '2020-03-01', 'x', 'expense', -100) $$,
  'a valid UNCATEGORIZED ordinary row is accepted'
);
rollback to savepoint valid_rows;

-- ============================================================
-- Rule 4: an adjustment carries no category
-- ============================================================

savepoint adjustment_category;
select throws_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, amount_cents)
     values ('1b000000-0000-4000-8000-000000000112', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', '2020-03-01', 'x', 'adjustment', '1b000000-0000-4000-8000-0000000000c1', -100) $$,
  '23514',
  null,
  'an adjustment carrying a category is rejected'
);
rollback to savepoint adjustment_category;

-- Both signs are legal for an adjustment: it is whatever delta
-- reconciles a derived balance to a real one, and a rule guessing its
-- direction now would be a rule CP5 has to fight.
savepoint adjustment_signs;
select lives_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents) values
       ('1b000000-0000-4000-8000-000000000113', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', '2020-03-01', 'up', 'adjustment', 4200),
       ('1b000000-0000-4000-8000-000000000114', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', '2020-03-01', 'down', 'adjustment', -4200) $$,
  'an adjustment is accepted with either sign'
);
rollback to savepoint adjustment_signs;

-- ============================================================
-- Movement legs inherit rules 1 and 2
-- ============================================================
-- CP4 will insert transfer and credit-card-payment legs through this
-- same table. A movement dated tomorrow, or landing in an archived
-- account, corrupts exactly the same figures as an ordinary row doing
-- it -- so the trigger covers every row rather than exempting legs, and
-- CP4 inherits the protection instead of having to remember it.

savepoint legs_future;
insert into public.movements (id, user_id, kind) values
  ('1b000000-0000-4000-8000-0000000000e1', '1b000000-0000-4000-8000-000000000001', 'transfer');
select throws_ok(
  format(
    $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values
         ('1b000000-0000-4000-8000-000000000115', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', %L, 'out', 'transfer', '1b000000-0000-4000-8000-0000000000e1', -100),
         ('1b000000-0000-4000-8000-000000000116', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a2', %L, 'in', 'transfer', '1b000000-0000-4000-8000-0000000000e1', 100) $$,
    pg_temp.d('a_tomorrow'), pg_temp.d('a_tomorrow')
  ),
  '23514',
  null,
  'a movement leg dated in the owner''s future is rejected, exactly like an ordinary row'
);
rollback to savepoint legs_future;
set constraints all deferred;

savepoint legs_archived;
insert into public.movements (id, user_id, kind) values
  ('1b000000-0000-4000-8000-0000000000e2', '1b000000-0000-4000-8000-000000000001', 'transfer');
select throws_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values
       ('1b000000-0000-4000-8000-000000000117', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', '2020-03-01', 'out', 'transfer', '1b000000-0000-4000-8000-0000000000e2', -100),
       ('1b000000-0000-4000-8000-000000000118', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a9', '2020-03-01', 'in', 'transfer', '1b000000-0000-4000-8000-0000000000e2', 100) $$,
  '23514',
  null,
  'a movement leg landing in an archived account is rejected, exactly like an ordinary row'
);
rollback to savepoint legs_archived;
set constraints all deferred;

-- The positive control for the two above: a well-formed pair of legs on
-- two active accounts, dated in the past, still commits. Without this,
-- both rejections could be passing because legs are broken generally.
savepoint legs_ok;
insert into public.movements (id, user_id, kind) values
  ('1b000000-0000-4000-8000-0000000000e3', '1b000000-0000-4000-8000-000000000001', 'transfer');
insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values
  ('1b000000-0000-4000-8000-000000000119', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', '2020-03-01', 'out', 'transfer', '1b000000-0000-4000-8000-0000000000e3', -100),
  ('1b000000-0000-4000-8000-00000000011a', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a2', '2020-03-01', 'in', 'transfer', '1b000000-0000-4000-8000-0000000000e3', 100);
select lives_ok(
  $$ set constraints all immediate $$,
  'a well-formed pair of past-dated legs on two active accounts still commits'
);
rollback to savepoint legs_ok;
set constraints all deferred;

-- ============================================================
-- The trigger is not a policy: it applies to `authenticated` too
-- ============================================================
-- Everything above ran as the migration owner. This is the same rule
-- seen from the role that will actually hit it in production, through
-- the CP3 INSERT grant and the ownership policy.

savepoint as_authenticated;
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '1b000000-0000-4000-8000-000000000001';

select throws_ok(
  format(
    $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents)
       values ('1b000000-0000-4000-8000-00000000011b', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', %L, 'x', 'expense', -100) $$,
    pg_temp.d('a_tomorrow')
  ),
  '23514',
  null,
  'authenticated cannot post a future-dated transaction either -- the trigger is not a policy'
);
select lives_ok(
  format(
    $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents)
       values ('1b000000-0000-4000-8000-00000000011c', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', %L, 'x', 'expense', -100) $$,
    pg_temp.d('a_yesterday')
  ),
  'authenticated can post a past-dated transaction -- the check above is not vacuous'
);
reset role;
rollback to savepoint as_authenticated;

-- No finish() -- this file uses SAVEPOINT/ROLLBACK TO SAVEPOINT
-- extensively, which rolls back pgtap's own internal bookkeeping (see
-- 020-movements.sql for the full explanation).
rollback;
