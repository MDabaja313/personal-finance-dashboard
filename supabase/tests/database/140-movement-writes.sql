-- Phase 7 CP4: movement writes, at the database.
--
-- 100-write-grants.sql proves *which operations* exist as privileges on
-- movements; 090-privileges.sql proves the two RPCs are SECURITY INVOKER
-- and executable by `authenticated` alone. This file proves what those
-- privileges and functions actually *do* -- by running real statements
-- as `authenticated`, with two different verified-claim uids and as
-- `anon`, against real rows.
--
-- ## The claim this file exists to establish
--
-- **A movement can only ever come into existence through one of the two
-- RPCs.** That is not a convention the application follows, it is a
-- property of the schema, and cases 1-3 below prove each half:
--
--   * A movements parent inserted alone cannot commit --
--     `movements_validate_movement` (Phase 4, AFTER INSERT, DEFERRABLE
--     INITIALLY DEFERRED) counts zero legs at COMMIT.
--   * A leg naming a movement that does not exist yet fails immediately
--     with 23503 -- `transactions_movement_fk` is NOT deferrable.
--   * A movement with one leg cannot commit either.
--
-- PostgREST issues one statement per request, each in its own
-- transaction, so no sequence of PostgREST calls can satisfy all three
-- at once. That is why create_movement/replace_movement exist, and why
-- the checks inside them are a real boundary rather than an
-- application-layer suggestion.
--
-- ## Deferred-trigger mechanics
--
-- pgTAP wraps the whole file in one rolled-back transaction, so a
-- DEFERRABLE INITIALLY DEFERRED trigger never fires on its own commit.
-- The cases that need it use a SAVEPOINT plus `SET CONSTRAINTS ALL
-- IMMEDIATE`, exactly as 020-movements.sql does -- including its
-- hard-won ordering rule: `SET CONSTRAINTS ALL DEFERRED` MUST come
-- **after** `ROLLBACK TO SAVEPOINT`, never before it, because
-- ROLLBACK TO undoes a constraint-mode change made after that savepoint
-- like any other transaction-local state. Getting it backwards leaves
-- the mode stuck at IMMEDIATE and aborts the script with a raw error
-- rather than a test failure.
--
-- The RPC cases do NOT need that dance: an exception raised inside a
-- plpgsql function propagates immediately, so throws_ok/lives_ok catch
-- it directly. Only the cases that deliberately leave an *invalid but
-- not-yet-checked* state behind force the constraint mode.
--
-- Fixture setup runs as the migration owner (postgres, BYPASSRLS), the
-- same arrangement 020/030/040/050/060/110 use.
begin;
select plan(61);

-- ============================================================
-- Fixture: two owners; owner A gets four accounts of three types
-- ============================================================
-- A's accounts cover every role a movement leg can play: two ordinary
-- asset accounts (transfer source and destination), a credit account (a
-- card payment's only legal destination), and an archived one (which
-- assert_transaction_refs() must refuse on either side).

insert into auth.users (id, aud, role, email) values
  ('1a000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'mvw-a@local.test'),
  ('1a000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'mvw-b@local.test');
insert into public.profiles (id) values
  ('1a000000-0000-4000-8000-000000000001'),
  ('1a000000-0000-4000-8000-000000000002');

insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents, is_archived) values
  ('1a000000-0000-4000-8000-0000000000a1', '1a000000-0000-4000-8000-000000000001', 'A-checking', 'Bank', 'checking', 100000, false),
  ('1a000000-0000-4000-8000-0000000000a2', '1a000000-0000-4000-8000-000000000001', 'A-savings',  'Bank', 'savings',   50000, false),
  ('1a000000-0000-4000-8000-0000000000a3', '1a000000-0000-4000-8000-000000000001', 'A-card',     'Card', 'credit',   -20000, false),
  ('1a000000-0000-4000-8000-0000000000a4', '1a000000-0000-4000-8000-000000000001', 'A-closed',   'Bank', 'checking',      0, true),
  ('1a000000-0000-4000-8000-0000000000b1', '1a000000-0000-4000-8000-000000000002', 'B-checking', 'Bank', 'checking', 100000, false),
  ('1a000000-0000-4000-8000-0000000000b2', '1a000000-0000-4000-8000-000000000002', 'B-savings',  'Bank', 'savings',   50000, false);

insert into public.categories (id, user_id, name, kind) values
  ('1a000000-0000-4000-8000-0000000000c1', '1a000000-0000-4000-8000-000000000001', 'A-cat', 'expense');

-- B owns a movement A must never see, edit, or delete.
insert into public.movements (id, user_id, kind) values
  ('1a000000-0000-4000-8000-0000000000e9', '1a000000-0000-4000-8000-000000000002', 'transfer');
insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values
  ('1a000000-0000-4000-8000-0000000000f8', '1a000000-0000-4000-8000-000000000002', '1a000000-0000-4000-8000-0000000000b1', '2026-01-05', 'B-out', 'transfer', '1a000000-0000-4000-8000-0000000000e9', -700),
  ('1a000000-0000-4000-8000-0000000000f9', '1a000000-0000-4000-8000-000000000002', '1a000000-0000-4000-8000-0000000000b2', '2026-01-05', 'B-in',  'transfer', '1a000000-0000-4000-8000-0000000000e9',  700);

-- ============================================================
-- As authenticated, claiming owner A
-- ============================================================

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '1a000000-0000-4000-8000-000000000001';

select is(
  (select auth.uid()),
  '1a000000-0000-4000-8000-000000000001'::uuid,
  'auth.uid() reflects the request.jwt.claim.sub GUC for owner A'
);

-- ============================================================
-- Cases 1-3: no partial movement can commit, by any route
-- ============================================================
-- This is what makes the RPCs the *only* creation path, rather than a
-- convenience over statements a caller could otherwise issue.

-- Case 1: a parent alone. The INSERT itself succeeds; COMMIT is where
-- it dies, which is precisely why the deferred trigger is deferred.
savepoint case_orphan;
select lives_ok(
  $$ insert into public.movements (id, user_id, kind)
     values ('1a000000-0000-4000-8000-0000000000d1', '1a000000-0000-4000-8000-000000000001', 'transfer') $$,
  'case 1: inserting a bare movements parent is permitted by GRANT and RLS'
);
select throws_matching(
  $$ set constraints all immediate $$,
  'expected exactly two legs, found 0',
  'case 1: but a childless movement cannot commit -- no orphan parent can ever exist'
);
rollback to savepoint case_orphan;
set constraints all deferred;

-- Case 2: a leg naming a movement that does not exist. The composite FK
-- (movement_id, user_id) -> movements is NOT deferrable, so this fails
-- at the statement rather than at COMMIT -- which is what rules out
-- "legs first, parent later".
select throws_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents)
     values ('1a000000-0000-4000-8000-0000000000f1', '1a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-0000000000a1', '2026-01-10', 'orphan leg', 'transfer', '1a000000-0000-4000-8000-0000000000d2', -100) $$,
  '23503',
  null,
  'case 2: a leg naming a non-existent movement fails immediately -- the movement FK is not deferrable'
);

-- Case 3: a parent with exactly one leg.
savepoint case_one_leg;
insert into public.movements (id, user_id, kind)
  values ('1a000000-0000-4000-8000-0000000000d3', '1a000000-0000-4000-8000-000000000001', 'transfer');
insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents)
  values ('1a000000-0000-4000-8000-0000000000f2', '1a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-0000000000a1', '2026-01-10', 'lonely', 'transfer', '1a000000-0000-4000-8000-0000000000d3', -100);
select throws_matching(
  $$ set constraints all immediate $$,
  'expected exactly two legs, found 1',
  'case 3: a one-leg movement cannot commit'
);
rollback to savepoint case_one_leg;
set constraints all deferred;

-- ============================================================
-- create_movement: the valid cases
-- ============================================================

-- A transfer. Everything about the two legs is derived: the merchants
-- from the movement's kind and the other account's name, the signs from
-- each leg's role.
select lives_ok(
  $$ select public.create_movement(
       '1a000000-0000-4000-8000-0000000000d4', 'transfer', '2026-01-15',
       '1a000000-0000-4000-8000-0000000000a1', '1a000000-0000-4000-8000-0000000000a2',
       25000,
       '1a000000-0000-4000-8000-0000000000f3', '1a000000-0000-4000-8000-0000000000f4') $$,
  'a valid transfer commits atomically through create_movement'
);
select is(
  (select count(*)::int from public.transactions where movement_id = '1a000000-0000-4000-8000-0000000000d4'),
  2,
  'and it wrote exactly two legs'
);
-- `sum(bigint)` is numeric in PostgreSQL, so the cast is required for
-- pgTAP to resolve `is()` at all -- not a stylistic tidy-up.
select is(
  (select sum(amount_cents)::bigint from public.transactions where movement_id = '1a000000-0000-4000-8000-0000000000d4'),
  0::bigint,
  'whose amounts sum to zero'
);
select is(
  (select amount_cents from public.transactions where id = '1a000000-0000-4000-8000-0000000000f3'),
  -25000::bigint,
  'the source leg is debited -- the sign came from its role, not from the caller'
);
select is(
  (select amount_cents from public.transactions where id = '1a000000-0000-4000-8000-0000000000f4'),
  25000::bigint,
  'the destination leg is credited by exactly the opposite amount'
);
select is(
  (select merchant from public.transactions where id = '1a000000-0000-4000-8000-0000000000f3'),
  'Transfer to A-savings',
  'the source leg''s merchant is derived from the destination account''s name'
);
select is(
  (select merchant from public.transactions where id = '1a000000-0000-4000-8000-0000000000f4'),
  'Transfer from A-checking',
  'and the destination leg''s from the source account''s name'
);
select is(
  (select count(*)::int from public.transactions
   where movement_id = '1a000000-0000-4000-8000-0000000000d4' and category_id is not null),
  0,
  'neither leg carries a category'
);
select is(
  (select count(*)::int from public.transactions
   where movement_id = '1a000000-0000-4000-8000-0000000000d4' and kind::text <> 'transfer'),
  0,
  'both legs carry the movement''s own kind'
);
select is(
  (select count(*)::int from public.transactions
   where movement_id = '1a000000-0000-4000-8000-0000000000d4'
     and user_id <> '1a000000-0000-4000-8000-000000000001'),
  0,
  'and both are owned by the caller -- the RPC took no user_id and derived it from auth.uid()'
);

-- The derived balances actually moved, in equal and opposite directions.
-- This is the financial claim, asserted against the same view the
-- application reads.
select is(
  (select balance_cents from public.account_balances where id = '1a000000-0000-4000-8000-0000000000a1'),
  75000::bigint,
  'the source account''s derived balance fell by exactly the amount'
);
select is(
  (select balance_cents from public.account_balances where id = '1a000000-0000-4000-8000-0000000000a2'),
  75000::bigint,
  'the destination account''s rose by exactly the same amount'
);

-- A credit card payment, into a credit account.
select lives_ok(
  $$ select public.create_movement(
       '1a000000-0000-4000-8000-0000000000d5', 'credit_card_payment', '2026-01-16',
       '1a000000-0000-4000-8000-0000000000a1', '1a000000-0000-4000-8000-0000000000a3',
       5000,
       '1a000000-0000-4000-8000-0000000000f5', '1a000000-0000-4000-8000-0000000000f6') $$,
  'a valid credit card payment commits atomically'
);
select is(
  (select balance_cents from public.account_balances where id = '1a000000-0000-4000-8000-0000000000a1'),
  70000::bigint,
  'the funding account decreases'
);
select is(
  (select balance_cents from public.account_balances where id = '1a000000-0000-4000-8000-0000000000a3'),
  -15000::bigint,
  'and the card''s (negative) balance moves toward zero by the same amount'
);
select is(
  (select merchant from public.transactions where id = '1a000000-0000-4000-8000-0000000000f5'),
  'Payment to A-card',
  'a card payment gets its own derived label, not a transfer''s'
);

-- ============================================================
-- create_movement: the refusals
-- ============================================================

-- The account-type rule the repository actually states: a card payment
-- is paid *into* a card. Nothing is enforced about the source's type.
select throws_ok(
  $$ select public.create_movement(
       '1a000000-0000-4000-8000-0000000000d6', 'credit_card_payment', '2026-01-16',
       '1a000000-0000-4000-8000-0000000000a1', '1a000000-0000-4000-8000-0000000000a2',
       5000,
       '1a000000-0000-4000-8000-0000000000fa', '1a000000-0000-4000-8000-0000000000fb') $$,
  '23514',
  null,
  'a card payment into a non-credit account is refused'
);
select lives_ok(
  $$ select public.create_movement(
       '1a000000-0000-4000-8000-0000000000d7', 'credit_card_payment', '2026-01-16',
       '1a000000-0000-4000-8000-0000000000a2', '1a000000-0000-4000-8000-0000000000a3',
       100,
       '1a000000-0000-4000-8000-0000000000fc', '1a000000-0000-4000-8000-0000000000fd') $$,
  'but paying a card from savings is fine -- no rule constrains the source''s type'
);

select throws_ok(
  $$ select public.create_movement(
       '1a000000-0000-4000-8000-0000000000d8', 'transfer', '2026-01-16',
       '1a000000-0000-4000-8000-0000000000a1', '1a000000-0000-4000-8000-0000000000a1',
       5000,
       '1a000000-0000-4000-8000-0000000000fe', '1a000000-0000-4000-8000-0000000000ff') $$,
  '23514',
  null,
  'both legs on the same account is refused'
);

select throws_ok(
  $$ select public.create_movement(
       '1a000000-0000-4000-8000-0000000000d9', 'transfer', '2026-01-16',
       '1a000000-0000-4000-8000-0000000000a1', '1a000000-0000-4000-8000-0000000000a2',
       0,
       '1a000000-0000-4000-8000-000000000f01', '1a000000-0000-4000-8000-000000000f02') $$,
  '23514',
  null,
  'a zero amount is refused -- legal for an ordinary row, never for a movement leg'
);
select throws_ok(
  $$ select public.create_movement(
       '1a000000-0000-4000-8000-0000000000da', 'transfer', '2026-01-16',
       '1a000000-0000-4000-8000-0000000000a1', '1a000000-0000-4000-8000-0000000000a2',
       -5000,
       '1a000000-0000-4000-8000-000000000f03', '1a000000-0000-4000-8000-000000000f04') $$,
  '23514',
  null,
  'a negative amount is refused -- the client posts a magnitude, never a sign'
);

-- Inherited from CP3's assert_transaction_refs(), which CP3 deliberately
-- wrote over every row so CP4 would not have to remember it. The ceiling
-- is the owner's own calendar day, computed from profiles.timezone.
select throws_ok(
  $$ select public.create_movement(
       '1a000000-0000-4000-8000-0000000000db', 'transfer', (current_date + 400),
       '1a000000-0000-4000-8000-0000000000a1', '1a000000-0000-4000-8000-0000000000a2',
       5000,
       '1a000000-0000-4000-8000-000000000f05', '1a000000-0000-4000-8000-000000000f06') $$,
  '23514',
  null,
  'a future-dated movement is refused by assert_transaction_refs(), inherited from CP3'
);

select throws_ok(
  $$ select public.create_movement(
       '1a000000-0000-4000-8000-0000000000dc', 'transfer', '2026-01-16',
       '1a000000-0000-4000-8000-0000000000a4', '1a000000-0000-4000-8000-0000000000a2',
       5000,
       '1a000000-0000-4000-8000-000000000f07', '1a000000-0000-4000-8000-000000000f08') $$,
  '23514',
  null,
  'an archived source account is refused -- unarchive it first'
);
select throws_ok(
  $$ select public.create_movement(
       '1a000000-0000-4000-8000-0000000000dd', 'transfer', '2026-01-16',
       '1a000000-0000-4000-8000-0000000000a1', '1a000000-0000-4000-8000-0000000000a4',
       5000,
       '1a000000-0000-4000-8000-000000000f09', '1a000000-0000-4000-8000-000000000f0a') $$,
  '23514',
  null,
  'and so is an archived destination account'
);

-- Cross-owner. B's account is invisible through RLS, so the lookup finds
-- nothing and the RPC refuses before any row is written.
select throws_ok(
  $$ select public.create_movement(
       '1a000000-0000-4000-8000-0000000000de', 'transfer', '2026-01-16',
       '1a000000-0000-4000-8000-0000000000a1', '1a000000-0000-4000-8000-0000000000b2',
       5000,
       '1a000000-0000-4000-8000-000000000f0b', '1a000000-0000-4000-8000-000000000f0c') $$,
  '23503',
  null,
  'A cannot move money into B''s account'
);

-- The idempotency collision the create form relies on: the same movement
-- id twice is a primary-key violation, not a second transfer.
select throws_ok(
  $$ select public.create_movement(
       '1a000000-0000-4000-8000-0000000000d4', 'transfer', '2026-01-15',
       '1a000000-0000-4000-8000-0000000000a1', '1a000000-0000-4000-8000-0000000000a2',
       25000,
       '1a000000-0000-4000-8000-000000000f0d', '1a000000-0000-4000-8000-000000000f0e') $$,
  '23505',
  null,
  'reusing a movement id collides on the primary key -- a retry cannot become a second transfer'
);
select is(
  (select count(*)::int from public.transactions where movement_id = '1a000000-0000-4000-8000-0000000000d4'),
  2,
  'and the original movement still has exactly its own two legs'
);

-- ============================================================
-- replace_movement
-- ============================================================

select lives_ok(
  $$ select public.replace_movement(
       '1a000000-0000-4000-8000-0000000000d4', 'transfer', '2026-01-20',
       '1a000000-0000-4000-8000-0000000000a2', '1a000000-0000-4000-8000-0000000000a1',
       30000,
       '1a000000-0000-4000-8000-0000000000f3', '1a000000-0000-4000-8000-0000000000f4') $$,
  'replace_movement rewrites a movement atomically -- amount, date and both account roles at once'
);
select is(
  (select count(*)::int from public.transactions where movement_id = '1a000000-0000-4000-8000-0000000000d4'),
  2,
  'still exactly two legs afterwards'
);
select is(
  (select account_id from public.transactions where id = '1a000000-0000-4000-8000-0000000000f3'),
  '1a000000-0000-4000-8000-0000000000a2'::uuid,
  'the source leg kept its row id while its account and amount changed'
);
select is(
  (select amount_cents from public.transactions where id = '1a000000-0000-4000-8000-0000000000f3'),
  -30000::bigint,
  'and its amount is the new magnitude, still debited'
);
select is(
  (select date from public.transactions where id = '1a000000-0000-4000-8000-0000000000f4'),
  '2026-01-20'::date,
  'both legs carry the new date'
);
select is(
  (select id from public.movements where id = '1a000000-0000-4000-8000-0000000000d4'),
  '1a000000-0000-4000-8000-0000000000d4'::uuid,
  'and the movement kept its original id -- an edit does not re-identify the thing being edited'
);

-- The property the whole delete-and-recreate design rests on: a
-- replacement that cannot be written leaves the ORIGINAL pair intact,
-- because the DELETE and the re-creation are one transaction.
select throws_ok(
  $$ select public.replace_movement(
       '1a000000-0000-4000-8000-0000000000d4', 'credit_card_payment', '2026-01-21',
       '1a000000-0000-4000-8000-0000000000a2', '1a000000-0000-4000-8000-0000000000a1',
       999,
       '1a000000-0000-4000-8000-0000000000f3', '1a000000-0000-4000-8000-0000000000f4') $$,
  '23514',
  null,
  'a deliberately invalid replacement (card payment into a checking account) is refused'
);
select is(
  (select count(*)::int from public.transactions where movement_id = '1a000000-0000-4000-8000-0000000000d4'),
  2,
  'and the original pair survives -- the DELETE was rolled back with everything else'
);
select is(
  (select amount_cents || ':' || date::text || ':' || account_id::text
   from public.transactions where id = '1a000000-0000-4000-8000-0000000000f3'),
  '-30000:2026-01-20:1a000000-0000-4000-8000-0000000000a2',
  'byte for byte: amount, date and account are exactly what they were before the failed edit'
);
select is(
  (select kind::text from public.movements where id = '1a000000-0000-4000-8000-0000000000d4'),
  'transfer',
  'and the parent still carries its original kind, not the refused one'
);

-- A future-dated replacement rolls back the same way, through the CP3
-- trigger rather than through the RPC's own checks -- so the atomicity
-- holds for a refusal raised anywhere inside the transaction.
select throws_ok(
  $$ select public.replace_movement(
       '1a000000-0000-4000-8000-0000000000d4', 'transfer', (current_date + 400),
       '1a000000-0000-4000-8000-0000000000a2', '1a000000-0000-4000-8000-0000000000a1',
       30000,
       '1a000000-0000-4000-8000-0000000000f3', '1a000000-0000-4000-8000-0000000000f4') $$,
  '23514',
  null,
  'a future-dated replacement is refused by the CP3 trigger'
);
select is(
  (select date from public.transactions where id = '1a000000-0000-4000-8000-0000000000f3'),
  '2026-01-20'::date,
  'and the original date survives that too'
);

-- Cross-owner: B's movement is invisible to A, so the explicit ownership
-- check refuses before the DELETE runs. Without it, `movements_delete_own`
-- would match zero rows and raise nothing -- the failure mode that looks
-- like success.
select throws_ok(
  $$ select public.replace_movement(
       '1a000000-0000-4000-8000-0000000000e9', 'transfer', '2026-01-20',
       '1a000000-0000-4000-8000-0000000000a1', '1a000000-0000-4000-8000-0000000000a2',
       100,
       '1a000000-0000-4000-8000-000000000f0f', '1a000000-0000-4000-8000-000000000f10') $$,
  '23514',
  null,
  'A cannot replace B''s movement'
);
-- That B's movement is *unharmed* cannot be asserted from here: A cannot
-- see B's rows at all, so a count of zero would prove nothing either way.
-- It is verified at the end of this file, as the migration owner.

-- ============================================================
-- SELECT and DELETE, own and foreign
-- ============================================================

select is(
  (select count(*)::int from public.movements),
  3,
  'A sees exactly its own three movements -- movements_select_own filters B''s out'
);
select is(
  (select count(*)::int from public.movements where user_id = '1a000000-0000-4000-8000-000000000002'),
  0,
  'and explicitly zero of B''s, filtered by B''s user_id'
);

-- Deleting the parent is the only correct way to remove a pair, and it
-- takes both legs with it. validate_movement() skips a movement whose
-- parent is gone, which is exactly what distinguishes this from deleting
-- a leg directly.
select lives_ok(
  $$ delete from public.movements where id = '1a000000-0000-4000-8000-0000000000d5' $$,
  'A can DELETE its own movement parent'
);
select is(
  (select count(*)::int from public.transactions where movement_id = '1a000000-0000-4000-8000-0000000000d5'),
  0,
  'and the cascade took exactly both of its legs'
);
select is(
  (select balance_cents from public.account_balances where id = '1a000000-0000-4000-8000-0000000000a3'),
  -19900::bigint,
  'the card''s balance is restored -- less only the second, smaller payment still on file'
);

-- A DELETE whose target fails USING raises nothing: it simply matches
-- zero rows. That is the dangerous shape, because it looks like it
-- worked, so it is asserted by re-reading B's row afterwards.
select lives_ok(
  $$ delete from public.movements where id = '1a000000-0000-4000-8000-0000000000e9' $$,
  'A''s DELETE targeting B''s movement raises nothing -- USING makes it invisible'
);

-- ============================================================
-- The ordinary transaction surface still cannot touch a leg
-- ============================================================
-- Re-asserted here, against legs written by the CP4 RPC rather than by a
-- fixture INSERT, because "the legs CP4 creates are the ones CP3
-- protects" is the property that actually matters and it is not implied
-- by either file alone.

select lives_ok(
  $$ update public.transactions set merchant = 'hijacked', amount_cents = -1
     where id = '1a000000-0000-4000-8000-0000000000f3' $$,
  'an ordinary UPDATE targeting an RPC-written leg raises nothing -- USING makes it invisible'
);
select is(
  (select merchant || ':' || amount_cents from public.transactions where id = '1a000000-0000-4000-8000-0000000000f3'),
  'Transfer to A-checking:-30000',
  'and it changed nothing'
);
select lives_ok(
  $$ delete from public.transactions where id = '1a000000-0000-4000-8000-0000000000f3' $$,
  'an ordinary DELETE targeting an RPC-written leg raises nothing -- USING makes it invisible'
);
select is(
  (select count(*)::int from public.transactions where movement_id = '1a000000-0000-4000-8000-0000000000d4'),
  2,
  'and the movement still has both legs'
);
select throws_ok(
  $$ update public.transactions set movement_id = '1a000000-0000-4000-8000-0000000000d4' where false $$,
  '42501',
  null,
  'and an ordinary row still cannot be adopted into a movement -- movement_id is not in the UPDATE grant'
);

-- A category on a movement leg is refused at the RPC's own INSERT, by
-- both a CHECK and the CP3 trigger. Asserted through the only path that
-- can write a leg, since there is no other.
select is(
  (select count(*)::int from public.transactions
   where movement_id is not null and category_id is not null),
  0,
  'no movement leg anywhere carries a category'
);

-- ============================================================
-- As anon: nothing at all
-- ============================================================

reset role;
set local role anon;

select throws_ok(
  $$ select count(*) from public.movements $$,
  '42501', null, 'anon cannot read movements'
);
select throws_ok(
  $$ delete from public.movements where false $$,
  '42501', null, 'anon cannot delete movements'
);

-- ============================================================
-- As the migration owner: B's movement was never touched
-- ============================================================
-- A's attempts above -- a replace and a delete aimed at B's movement --
-- were both refused or matched nothing, but A cannot observe B's rows to
-- prove it. postgres has BYPASSRLS, so this is the only role that can
-- actually check. Without this section the two assertions above would
-- pass identically whether B's movement survived or was destroyed, which
-- is exactly the failure mode a silent zero-row DELETE produces.

reset role;

select is(
  (select count(*)::int from public.movements where id = '1a000000-0000-4000-8000-0000000000e9'),
  1,
  'B''s movement parent still exists after A''s refused replace and no-op delete'
);
select is(
  (select string_agg(amount_cents::text, ',' order by amount_cents)
   from public.transactions where movement_id = '1a000000-0000-4000-8000-0000000000e9'),
  '-700,700',
  'and both of its original legs are intact, with their original amounts'
);

-- No `select * from finish();` -- this file uses SAVEPOINT/ROLLBACK TO
-- SAVEPOINT for the deferred-trigger cases, which rolls back pgtap's own
-- bookkeeping table along with everything else. See 020-movements.sql
-- for the full explanation; plan() matching the assertion count is what
-- makes the TAP output correct.
rollback;
