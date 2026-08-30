-- Phase 7 Checkpoint 5: account reconciliation, in the database.
--
-- `public.reconcile_account` is SECURITY INVOKER and takes no owner, so
-- every assertion below runs as `authenticated` with a verified-claim
-- uid set, exactly as PostgREST does it. Nothing here runs as the
-- migration owner except the fixture setup, and the two owners exist so
-- that "your own account" is a real distinction rather than a
-- vacuous one.
--
-- ============================================================
-- What this file proves, and what it deliberately leaves elsewhere
-- ============================================================
--
-- Proved here, because these are database facts:
--
--   * The delta is derived in SQL from opening_balance + SUM(ledger),
--     including movement legs and earlier adjustments, and the row
--     written is exactly that delta.
--   * A zero delta writes no row -- which is also what makes
--     reconciliation idempotent without an idempotency key.
--   * The refusals: another owner's account, an archived account, a
--     future as-of date, an unauthenticated caller, a target balance
--     outside the representable range.
--   * The shape of what is written: kind 'adjustment', category null,
--     movement null, a deterministic label, the requested date.
--   * The adjustment lifecycle: never editable, always deletable by its
--     owner -- and CP3's movement-leg protections still hold.
--
-- Left to tests/mutations/reconciliation.test.ts, because they are
-- TypeScript facts:
--
--   * THE LIABILITY INPUT CONVERSION. This function's parameter has
--     exactly one meaning -- the desired *internal signed* balance --
--     and that is deliberate: a parameter whose interpretation flipped
--     based on a row it looked up would be a parameter no caller could
--     reason about, and an overpaid credit card (a positive balance on a
--     `credit` account) is a legal state such a rule would make
--     unreachable. Turning "$450 owed" into -45000 happens in
--     lib/data/mutations/reconciliation.ts, from the account's own
--     stored type. What this file proves is the half that lives here:
--     that a negative desired balance on a credit account produces the
--     correct delta and lands the balance exactly.
--   * That the *deletion path* refuses a non-adjustment row. At the SQL
--     layer an owned ordinary row is legitimately deletable -- that is
--     CP3's `deleteTransaction` -- so "only an adjustment" is a property
--     of the reconciliation mutation module, not of the policy. What is
--     asserted here is the policy's own boundary: a movement leg stays
--     undeletable, and another owner's adjustment stays invisible.
begin;
select plan(35);

-- ============================================================
-- Fixture: two owners; four accounts for A, one for B
-- ============================================================
-- Every account's opening balance is a round figure and every derived
-- balance below is hand-computable, so an expected delta can be asserted
-- verbatim rather than recomputed by the same expression under test.

insert into auth.users (id, aud, role, email) values
  ('1b000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'recon-a@local.test'),
  ('1b000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'recon-b@local.test');
insert into public.profiles (id) values
  ('1b000000-0000-4000-8000-000000000001'),
  ('1b000000-0000-4000-8000-000000000002');

-- a4 is inserted already archived rather than archived by a follow-up
-- UPDATE: CP2's accounts_guard_update() refuses the false -> true
-- transition unless the derived balance is exactly zero, and this
-- fixture only needs the archived *state*. The guard's own behavior is
-- 120-account-guard.sql.
insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents, is_archived) values
  ('1b000000-0000-4000-8000-0000000000a1', '1b000000-0000-4000-8000-000000000001', 'A-checking', 'Bank', 'checking', 100000, false),
  ('1b000000-0000-4000-8000-0000000000a2', '1b000000-0000-4000-8000-000000000001', 'A-card', 'Bank', 'credit', -60000, false),
  ('1b000000-0000-4000-8000-0000000000a3', '1b000000-0000-4000-8000-000000000001', 'A-loan', 'Bank', 'loan', -100000, false),
  ('1b000000-0000-4000-8000-0000000000a4', '1b000000-0000-4000-8000-000000000001', 'A-archived', 'Bank', 'checking', 0, true),
  ('1b000000-0000-4000-8000-0000000000a5', '1b000000-0000-4000-8000-000000000001', 'A-savings', 'Bank', 'savings', 0, false),
  ('1b000000-0000-4000-8000-0000000000b1', '1b000000-0000-4000-8000-000000000002', 'B-checking', 'Bank', 'checking', 500000, false);

-- One ordinary row and one transfer pair on A-savings, so the derived
-- balance the function computes is provably "opening + SUM(everything)"
-- rather than "opening + SUM(ordinary rows)". Dated in the past, so the
-- posted-date ceiling is never incidentally the thing under test -- that
-- rule gets its own assertion below and has 135-posted-ledger.sql to
-- itself.
insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents) values
  ('1b000000-0000-4000-8000-0000000000f1', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a5', '2026-01-10', 'A-expense', 'expense', -7000);
insert into public.movements (id, user_id, kind) values
  ('1b000000-0000-4000-8000-0000000000e1', '1b000000-0000-4000-8000-000000000001', 'transfer');
insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values
  ('1b000000-0000-4000-8000-0000000000c1', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a1', '2026-01-12', 'out', 'transfer', '1b000000-0000-4000-8000-0000000000e1', -30000),
  ('1b000000-0000-4000-8000-0000000000c2', '1b000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-0000000000a5', '2026-01-12', 'in', 'transfer', '1b000000-0000-4000-8000-0000000000e1', 30000);

-- B gets one adjustment of their own, so "A cannot delete it" is a
-- statement about an adjustment that actually exists.
insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents) values
  ('1b000000-0000-4000-8000-0000000000d1', '1b000000-0000-4000-8000-000000000002', '1b000000-0000-4000-8000-0000000000b1', '2026-01-15', 'Balance adjustment', 'adjustment', -2500);

-- The owner's own calendar day, from their own profile timezone -- the
-- same expression assert_transaction_refs() uses. Derived rather than
-- hardcoded so this file does not age out of correctness.
create temporary table recon_dates on commit drop as
select
  (now() at time zone p.timezone)::date as owner_today,
  ((now() at time zone p.timezone)::date + 1) as owner_tomorrow
from public.profiles p
where p.id = '1b000000-0000-4000-8000-000000000001';

grant select on recon_dates to authenticated;

-- ============================================================
-- Act as owner A
-- ============================================================

set local role authenticated;
set local request.jwt.claim.sub = '1b000000-0000-4000-8000-000000000001';

select is(auth.uid(), '1b000000-0000-4000-8000-000000000001'::uuid, 'auth.uid() reflects the claim for owner A');

-- ============================================================
-- 1. An asset account, reconciled downward
-- ============================================================
-- A-checking: opening 100000, one transfer leg of -30000 -> derived
-- 70000. Observed 65000, so the correction is -5000.

select is(
  (select balance_cents from public.account_balances where id = '1b000000-0000-4000-8000-0000000000a1'),
  70000::bigint,
  'A-checking derives to opening + the movement leg before any reconciliation'
);

select is(
  (select public.reconcile_account('1b000000-0000-4000-8000-0000000000a1', (select owner_today from recon_dates), 65000) ->> 'created'),
  'true',
  'reconciling an owned, active asset account reports that an adjustment was created'
);

select is(
  (select balance_cents from public.account_balances where id = '1b000000-0000-4000-8000-0000000000a1'),
  65000::bigint,
  'the derived balance now equals the observed balance exactly'
);

select is(
  (select t.amount_cents from public.transactions t
   where t.account_id = '1b000000-0000-4000-8000-0000000000a1' and t.kind = 'adjustment'),
  -5000::bigint,
  'the adjustment is exactly the delta -- observed minus derived, not the observed figure'
);

-- The shape of the row, asserted field by field rather than as one
-- composite: each of these is refused by a different mechanism (a CHECK,
-- the trigger, the function body), and a composite comparison would not
-- say which one had stopped holding.
select is(
  (select t.category_id from public.transactions t
   where t.account_id = '1b000000-0000-4000-8000-0000000000a1' and t.kind = 'adjustment'),
  null,
  'the adjustment carries no category'
);
select is(
  (select t.movement_id from public.transactions t
   where t.account_id = '1b000000-0000-4000-8000-0000000000a1' and t.kind = 'adjustment'),
  null,
  'the adjustment carries no movement'
);
select is(
  (select t.merchant from public.transactions t
   where t.account_id = '1b000000-0000-4000-8000-0000000000a1' and t.kind = 'adjustment'),
  'Balance adjustment',
  'the adjustment gets the deterministic label composed in SQL -- never caller text'
);
select is(
  (select t.date from public.transactions t
   where t.account_id = '1b000000-0000-4000-8000-0000000000a1' and t.kind = 'adjustment'),
  (select owner_today from recon_dates),
  'the adjustment is dated as of the day the observation was true'
);

-- ============================================================
-- 2. Reconciling again is a no-op, without an idempotency key
-- ============================================================
-- The second submission computes its delta against a balance the first
-- one already corrected. That is what makes a double-click safe here
-- while CP3 and CP4 needed a client-minted UUID: a second identical
-- reconciliation is not a second event, it is the same observation
-- restated.

select is(
  (select public.reconcile_account('1b000000-0000-4000-8000-0000000000a1', (select owner_today from recon_dates), 65000) ->> 'created'),
  'false',
  'reconciling to a balance that already matches reports that nothing was created'
);

select is(
  (select count(*)::int from public.transactions t
   where t.account_id = '1b000000-0000-4000-8000-0000000000a1' and t.kind = 'adjustment'),
  1,
  'and writes no second adjustment -- a zero delta produces zero rows'
);

select is(
  (select public.reconcile_account('1b000000-0000-4000-8000-0000000000a1', (select owner_today from recon_dates), 65000) ->> 'delta_cents'),
  '0',
  'the zero-delta result reports a delta of exactly 0'
);

-- ============================================================
-- 3. A liability account, in internal signed terms
-- ============================================================
-- A-card: opening -60000, no transactions -> derived -60000 ("$600
-- owed"). The person types 450 into a field labelled "Amount currently
-- owed"; lib/data/mutations/reconciliation.ts negates that into -45000
-- from the account's stored type, and *that* is what reaches this
-- parameter. The correction is therefore +15000 -- the card is paid down
-- by $150 more than this application knew about.

select is(
  (select public.reconcile_account('1b000000-0000-4000-8000-0000000000a2', (select owner_today from recon_dates), -45000) ->> 'delta_cents'),
  '15000',
  'a credit account reconciled from -$600 to -$450 owed produces a +$150 adjustment'
);

select is(
  (select balance_cents from public.account_balances where id = '1b000000-0000-4000-8000-0000000000a2'),
  -45000::bigint,
  'the credit account now derives to exactly the desired internal (negative) balance'
);

-- A loan paid off entirely: -100000 -> 0. The sign of an adjustment is
-- unconstrained (transactions_sign_by_kind_ck's adjustment branch), which
-- is what lets one correction be negative and another positive.
select is(
  (select public.reconcile_account('1b000000-0000-4000-8000-0000000000a3', (select owner_today from recon_dates), 0) ->> 'delta_cents'),
  '100000',
  'a loan reconciled to nothing owed produces a +$1000 adjustment'
);
select is(
  (select balance_cents from public.account_balances where id = '1b000000-0000-4000-8000-0000000000a3'),
  0::bigint,
  'the loan now derives to exactly zero'
);

-- ============================================================
-- 4. The derived balance includes every kind of row
-- ============================================================
-- A-savings: opening 0, an expense of -7000, a transfer leg of +30000 ->
-- derived 23000. If the function summed only ordinary rows, or excluded
-- movement legs the way countsAsSpending does, the delta below would be
-- wrong by exactly the leg.

select is(
  (select public.reconcile_account('1b000000-0000-4000-8000-0000000000a5', (select owner_today from recon_dates), 23000) ->> 'created'),
  'false',
  'an account whose ledger includes a movement leg is already reconciled at opening + SUM(everything)'
);

-- ...and now with an earlier adjustment in the sum too, so a second
-- reconciliation is computed against the corrected balance rather than
-- the original one.
select is(
  (select public.reconcile_account('1b000000-0000-4000-8000-0000000000a1', (select owner_today from recon_dates), 60000) ->> 'delta_cents'),
  '-5000',
  'a later reconciliation is computed against the already-adjusted balance'
);
select is(
  (select balance_cents from public.account_balances where id = '1b000000-0000-4000-8000-0000000000a1'),
  60000::bigint,
  'and lands the balance exactly, with two stacked adjustments'
);

-- ============================================================
-- 5. The refusals
-- ============================================================

-- The posted-date ceiling is assert_transaction_refs()'s, not this
-- function's, and it compares against the owner's own calendar day
-- computed from profiles.timezone -- never server UTC.
select throws_ok(
  format(
    $$ select public.reconcile_account('1b000000-0000-4000-8000-0000000000a1', %L::date, 1) $$,
    (select owner_tomorrow from recon_dates)
  ),
  '23514', null,
  'an as-of date later than the owner''s own calendar day is refused'
);

select throws_ok(
  $$ select public.reconcile_account('1b000000-0000-4000-8000-0000000000a4', current_date, 1000) $$,
  '23514', null,
  'an archived account cannot be reconciled'
);

-- Another owner's account is invisible through accounts_select_own, so
-- the lookup finds nothing and the function refuses with the same code
-- the composite FK would have produced.
select throws_ok(
  $$ select public.reconcile_account('1b000000-0000-4000-8000-0000000000b1', current_date, 1000) $$,
  '23503', null,
  'another owner''s account cannot be reconciled'
);

select is(
  (select count(*)::int from public.transactions t
   where t.user_id = '1b000000-0000-4000-8000-000000000002' and t.kind = 'adjustment'),
  0,
  'and no row was written into the other owner''s ledger (A cannot even see B''s own adjustment)'
);

-- A target balance outside the safe-integer range the `Cents` brand
-- guarantees. Refused before anything is written, rather than stored and
-- read back imprecisely.
select throws_ok(
  $$ select public.reconcile_account('1b000000-0000-4000-8000-0000000000a1', current_date, 9007199254740992) $$,
  '22003', null,
  'a target balance outside the representable range is refused'
);

-- ============================================================
-- 6. An unauthenticated caller
-- ============================================================
-- `anon` cannot reach the function at all (090-privileges.sql). This is
-- the other half: the `authenticated` role with no claim in the session,
-- which is what a misconfigured request looks like.

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '';

select throws_ok(
  $$ select public.reconcile_account('1b000000-0000-4000-8000-0000000000a1', current_date, 1) $$,
  '28000', null,
  'a session with no verified claim cannot reconcile anything'
);

set local request.jwt.claim.sub = '1b000000-0000-4000-8000-000000000001';

-- ============================================================
-- 7. The adjustment lifecycle: never editable, always removable
-- ============================================================
-- Both halves of `transactions_update_own_ordinary`'s
-- `kind <> 'adjustment'` clause, and the two halves fail *differently*
-- -- which is itself worth pinning, because the difference is what
-- decides whether a caller can tell a refusal from a no-op.
--
-- USING: an existing adjustment is invisible to the statement, so the
-- UPDATE matches zero rows and raises nothing at all. Proved by
-- re-reading the row rather than by trusting the absence of a throw.
update public.transactions set amount_cents = -1
where account_id = '1b000000-0000-4000-8000-0000000000a1' and kind = 'adjustment';

select is(
  (select count(*)::int from public.transactions t
   where t.account_id = '1b000000-0000-4000-8000-0000000000a1'
     and t.kind = 'adjustment' and t.amount_cents = -1),
  0,
  'an existing adjustment cannot be edited -- USING makes it invisible to UPDATE'
);

-- WITH CHECK: the *target* row is an ordinary one and passes USING, so
-- the statement reaches the row and is then refused on the value it
-- would produce. That is a raise, not a silent no-op.
select throws_ok(
  $$ update public.transactions set kind = 'adjustment'
     where id = '1b000000-0000-4000-8000-0000000000f1' $$,
  '42501', null,
  'an ordinary row cannot be retyped into an adjustment -- WITH CHECK refuses the new kind'
);

select is(
  (select kind from public.transactions where id = '1b000000-0000-4000-8000-0000000000f1'),
  'expense'::public.transaction_kind,
  'and the ordinary row is left exactly as it was'
);

-- DELETE is deliberately open on an adjustment, and that is the whole
-- reason CP3's transactions_delete_own_non_movement carries only
-- `movement_id is null`: correcting a bad reconciliation means removing
-- the adjustment and reconciling again.
create temporary table recon_victim on commit drop as
select id from public.transactions
where account_id = '1b000000-0000-4000-8000-0000000000a1' and kind = 'adjustment'
order by amount_cents
limit 1;

delete from public.transactions where id in (select id from recon_victim);

select is(
  (select count(*)::int from public.transactions t where t.id in (select id from recon_victim)),
  0,
  'an owned adjustment can be deleted -- the undo half of reconcile-again'
);

select is(
  (select balance_cents from public.account_balances where id = '1b000000-0000-4000-8000-0000000000a1'),
  65000::bigint,
  'removing an adjustment moves the derived balance back by exactly that adjustment'
);

-- And the CP3/CP4 protections the same policy carries are untouched.
delete from public.transactions where id = '1b000000-0000-4000-8000-0000000000c1';

select is(
  (select count(*)::int from public.transactions where id = '1b000000-0000-4000-8000-0000000000c1'),
  1,
  'a movement leg is still undeletable -- CP4''s protection is unchanged by CP5'
);

delete from public.transactions where id = '1b000000-0000-4000-8000-0000000000d1';

-- Checked back as the migration owner, not as A. Acting as A, B's row is
-- invisible to SELECT as well as to DELETE, so counting it from here
-- would report zero whether the delete had been refused or had
-- succeeded -- an assertion that passes for the wrong reason. Stepping
-- out of the role is the only way to see which actually happened.
reset role;

select is(
  (select count(*)::int from public.transactions t
   where t.id = '1b000000-0000-4000-8000-0000000000d1'),
  1,
  'another owner''s adjustment is invisible to DELETE and survives untouched'
);

-- ============================================================
-- 8. CP5 widened no privilege
-- ============================================================
-- Reconciliation is a new operation over CP3's existing grants, not a
-- new grant. The full matrix is 100-write-grants.sql; these are the
-- three that a reconciliation feature would most plausibly have reached
-- for and must not have.

select ok(
  not has_any_column_privilege('authenticated', 'public.net_worth_snapshots', 'insert')
  and not has_any_column_privilege('authenticated', 'public.net_worth_snapshots', 'update')
  and not has_table_privilege('authenticated', 'public.net_worth_snapshots', 'delete'),
  'authenticated still cannot write net_worth_snapshots directly -- only through the CP5 bridge'
);

select ok(
  not has_table_privilege('authenticated', 'public.movements', 'update'),
  'movements still has no UPDATE grant'
);

select ok(
  not has_table_privilege('authenticated', 'public.accounts', 'delete')
  and not has_table_privilege('authenticated', 'public.categories', 'delete'),
  'accounts and categories are still archived rather than deleted'
);

reset role;

select * from finish();
rollback;
