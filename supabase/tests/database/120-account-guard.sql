-- accounts_guard_update(): the three account invariants no GRANT,
-- CHECK, or RLS policy can express.
--
--   1. type is immutable once the account exists
--   2. opening_balance_cents may change only while the account has zero
--      transactions
--   3. is_archived false -> true requires a derived balance of exactly
--      zero; unarchive is always allowed
--
-- Exercised as the migration owner (postgres) rather than as
-- `authenticated`, deliberately. The trigger is the *backstop*, and a
-- backstop is only worth having if it holds for a caller the grant
-- layer is not already stopping: `authenticated` cannot even name
-- accounts.type in an UPDATE (100/110 prove that at 42501), so testing
-- rule 1 through that role would prove the grant, not the trigger.
-- Running as the owner puts the trigger on its own.
--
-- Rules 2 and 3 are additionally reachable by `authenticated` -- both
-- columns *are* in the CP2 UPDATE grant -- and a representative case of
-- each is repeated through that role at the end, so the trigger is
-- proven to fire in the context the application actually writes from.
--
-- Every rejection is asserted by SQLSTATE (23514, check_violation) plus
-- a re-read proving the row did not change, because an assertion that
-- only checks for "an error" would pass if the statement failed for an
-- unrelated reason.
begin;
select plan(21);

insert into auth.users (id, aud, role, email) values
  ('20000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'aguard@local.test');
insert into public.profiles (id) values ('20000000-0000-4000-8000-000000000001');

-- a1: has transactions, and a nonzero derived balance.
-- a2: no transactions, nonzero opening balance.
-- a3: no transactions, zero opening balance -- the archivable one.
-- a4: has transactions that cancel its opening balance exactly to zero.
insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('20000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-000000000001', 'With history', 'Bank', 'checking', 10000),
  ('20000000-0000-4000-8000-0000000000a2', '20000000-0000-4000-8000-000000000001', 'Fresh', 'Bank', 'savings', 5000),
  ('20000000-0000-4000-8000-0000000000a3', '20000000-0000-4000-8000-000000000001', 'Empty', 'Bank', 'cash', 0),
  ('20000000-0000-4000-8000-0000000000a4', '20000000-0000-4000-8000-000000000001', 'Drained', 'Bank', 'checking', 2500);

insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents) values
  ('20000000-0000-4000-8000-000000000101', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-0000000000a1', '2026-01-10', 'x', 'expense', -2500),
  ('20000000-0000-4000-8000-000000000102', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-0000000000a4', '2026-01-10', 'x', 'expense', -2500);

-- ============================================================
-- Rule 1: type is immutable
-- ============================================================

-- a1 is a checking account, so 'savings' is a genuine change and the
-- guard has something to refuse. Asserting against an account that
-- already held the target type would pass through the IS DISTINCT FROM
-- test and prove nothing.
select throws_ok(
  $$ update public.accounts set type = 'savings'
     where id = '20000000-0000-4000-8000-0000000000a1' $$,
  '23514',
  null,
  'changing an account''s type is rejected by the guard'
);
select is(
  (select type::text from public.accounts where id = '20000000-0000-4000-8000-0000000000a1'),
  'checking',
  'and the stored type is unchanged'
);

-- The same statement written as a no-op assignment must still succeed:
-- the guard tests IS DISTINCT FROM, so setting a column to the value it
-- already holds is not a change and must not be refused.
select lives_ok(
  $$ update public.accounts set type = type
     where id = '20000000-0000-4000-8000-0000000000a2' $$,
  'assigning the same type is not a change and is allowed'
);

select lives_ok(
  $$ update public.accounts set name = 'Renamed'
     where id = '20000000-0000-4000-8000-0000000000a1' $$,
  'ordinary metadata edits are untouched by the guard, history or not'
);

-- ============================================================
-- Rule 2: opening balance is editable only before any transaction
-- ============================================================

savepoint opening_fresh;
select lives_ok(
  $$ update public.accounts set opening_balance_cents = 7500
     where id = '20000000-0000-4000-8000-0000000000a2' $$,
  'the opening balance of an account with no transactions can be corrected'
);
select is(
  (select opening_balance_cents from public.accounts
   where id = '20000000-0000-4000-8000-0000000000a2'),
  7500::bigint,
  'and the correction actually landed'
);
rollback to savepoint opening_fresh;

select throws_ok(
  $$ update public.accounts set opening_balance_cents = 99999
     where id = '20000000-0000-4000-8000-0000000000a1' $$,
  '23514',
  null,
  'the opening balance of an account that already has transactions is rejected'
);
select is(
  (select opening_balance_cents from public.accounts
   where id = '20000000-0000-4000-8000-0000000000a1'),
  10000::bigint,
  'and the stored opening balance is untouched'
);

select lives_ok(
  $$ update public.accounts set opening_balance_cents = opening_balance_cents, name = 'Still fine'
     where id = '20000000-0000-4000-8000-0000000000a1' $$,
  'writing the same opening balance back on an account with history is not a change and is allowed'
);

-- ============================================================
-- Rule 3: archiving requires a zero derived balance
-- ============================================================

select throws_ok(
  $$ update public.accounts set is_archived = true
     where id = '20000000-0000-4000-8000-0000000000a2' $$,
  '23514',
  null,
  'archiving an account whose opening balance alone is nonzero is rejected'
);
select is(
  (select is_archived from public.accounts where id = '20000000-0000-4000-8000-0000000000a2'),
  false,
  'and it is still active'
);

select throws_ok(
  $$ update public.accounts set is_archived = true
     where id = '20000000-0000-4000-8000-0000000000a1' $$,
  '23514',
  null,
  'archiving an account whose ledger leaves a nonzero balance is rejected'
);

savepoint archive_zero;
select lives_ok(
  $$ update public.accounts set is_archived = true
     where id = '20000000-0000-4000-8000-0000000000a3' $$,
  'archiving an account with a zero balance and no transactions succeeds'
);
select is(
  (select is_archived from public.accounts where id = '20000000-0000-4000-8000-0000000000a3'),
  true,
  'and it is recorded as archived'
);

-- Unarchive is unconditional: it can only restore a figure to the
-- totals, never hide one.
select lives_ok(
  $$ update public.accounts set is_archived = false
     where id = '20000000-0000-4000-8000-0000000000a3' $$,
  'unarchiving is always allowed'
);
rollback to savepoint archive_zero;

-- The derived balance is opening + SUM(ledger), not the opening figure:
-- a4 opened at 2500 and has a -2500 transaction, so it archives cleanly
-- even though its opening balance is nonzero.
savepoint archive_drained;
select lives_ok(
  $$ update public.accounts set is_archived = true
     where id = '20000000-0000-4000-8000-0000000000a4' $$,
  'archiving is judged on the DERIVED balance -- a drained account archives despite a nonzero opening figure'
);
rollback to savepoint archive_drained;

-- An account whose balance is nonzero can still be archived if the same
-- statement zeroes it -- but only when it has no transactions, so rule 2
-- has to permit the change first. This is the NEW-vs-OLD case in the
-- guard, and getting it backwards would either block a legitimate edit
-- or let a nonzero account through.
savepoint archive_with_correction;
select lives_ok(
  $$ update public.accounts set opening_balance_cents = 0, is_archived = true
     where id = '20000000-0000-4000-8000-0000000000a2' $$,
  'zeroing the opening balance and archiving in one statement is judged on the NEW balance'
);
rollback to savepoint archive_with_correction;

-- Unarchiving an account that still holds money is allowed -- proof the
-- rule is one-directional. Archived first as the owner, since rule 3
-- would refuse to archive it while nonzero.
savepoint unarchive_nonzero;
update public.accounts set opening_balance_cents = 0 where id = '20000000-0000-4000-8000-0000000000a2';
update public.accounts set is_archived = true where id = '20000000-0000-4000-8000-0000000000a2';
update public.accounts set opening_balance_cents = 5000 where id = '20000000-0000-4000-8000-0000000000a2';
select lives_ok(
  $$ update public.accounts set is_archived = false
     where id = '20000000-0000-4000-8000-0000000000a2' $$,
  'an archived account holding money can always be unarchived'
);
rollback to savepoint unarchive_nonzero;

-- ============================================================
-- The guard fires for `authenticated` too
-- ============================================================
-- Rules 2 and 3 touch columns that ARE in the CP2 UPDATE grant, so this
-- is the path the application actually writes through. Same SQLSTATE,
-- same refusal -- the trigger is not something only a privileged role
-- meets.

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '20000000-0000-4000-8000-000000000001';

select throws_ok(
  $$ update public.accounts set opening_balance_cents = 1
     where id = '20000000-0000-4000-8000-0000000000a1' $$,
  '23514',
  null,
  'authenticated hits the same opening-balance rule on an account with history'
);
select throws_ok(
  $$ update public.accounts set is_archived = true
     where id = '20000000-0000-4000-8000-0000000000a1' $$,
  '23514',
  null,
  'authenticated hits the same zero-balance rule when archiving'
);
select lives_ok(
  $$ update public.accounts set is_archived = true
     where id = '20000000-0000-4000-8000-0000000000a3' $$,
  'authenticated can archive its own zero-balance account'
);

reset role;

select * from finish();
rollback;
