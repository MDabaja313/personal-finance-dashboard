-- Phase 8 Checkpoint 1: settling a bill occurrence into the ledger.
--
-- The behavior half of 20260902120001_bill_payment_ledger.sql. The privilege
-- matrix is 100-write-grants.sql, the function inventory is 000/090, and the
-- application-level end-to-end coverage is tests/mutations/bill-occurrences.ts;
-- this file proves what the *database* refuses and produces, as
-- `authenticated`, with RLS forced.
--
-- Four things are being established, in order:
--
--   1. **A scheduled or skipped occurrence writes no ledger row.** The
--      projection stays a projection.
--   2. **Settling produces exactly one of four outcomes**, decided in SQL from
--      stored state: linked, generated, status-only, or already-paid.
--   3. **Provenance cannot be forged.** `'generated'` is accepted only for a
--      transaction created by the same database transaction, and the column
--      `authenticated` would need in order to fake that -- transactions.created_at
--      -- is absent from both its INSERT and its UPDATE grant.
--   4. **Reversal is exact.** A generated payment is removed; a linked one is
--      never touched, under any circumstance.
--
-- Fixture rows are inserted as the migration owner (postgres has BYPASSRLS),
-- exactly as every other file here seeds. Every *assertion* runs as
-- `authenticated` with a verified claim, which is the only role whose behavior
-- is in question.
begin;
select plan(44);

-- ============================================================
-- Fixture: two owners, so every cross-owner refusal is real
-- ============================================================

insert into auth.users (id, aud, role, email) values
  ('20000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'pay-a@local.test'),
  ('20000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'pay-b@local.test');
insert into public.profiles (id, timezone) values
  ('20000000-0000-4000-8000-000000000001', 'UTC'),
  ('20000000-0000-4000-8000-000000000002', 'UTC');

insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('20000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-000000000001', 'A-checking', 'Bank', 'checking', 500000),
  -- Archived, and at exactly zero so accounts_guard_update()'s own rule is
  -- respected by the fixture rather than bypassed by it.
  ('20000000-0000-4000-8000-0000000000a2', '20000000-0000-4000-8000-000000000001', 'A-closed', 'Bank', 'savings', 0),
  ('20000000-0000-4000-8000-0000000000a9', '20000000-0000-4000-8000-000000000002', 'B-checking', 'Bank', 'checking', 500000);

insert into public.categories (id, user_id, name, kind) values
  ('20000000-0000-4000-8000-0000000000c1', '20000000-0000-4000-8000-000000000001', 'A-utilities', 'expense'),
  ('20000000-0000-4000-8000-0000000000c2', '20000000-0000-4000-8000-000000000001', 'A-salary', 'income');

-- Four bills, each isolating one branch of the settle function.
insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date, category_id, account_id) values
  -- Generates: active account, active expense category.
  ('20000000-0000-4000-8000-0000000000b1', '20000000-0000-4000-8000-000000000001', 'Electric', 12000, 'monthly', '2026-01-05', '20000000-0000-4000-8000-0000000000c1', '20000000-0000-4000-8000-0000000000a1'),
  -- Generates uncategorized: the bill's category is an *income* category,
  -- which assert_transaction_refs() would refuse on an expense.
  ('20000000-0000-4000-8000-0000000000b2', '20000000-0000-4000-8000-000000000001', 'Oddly Filed', 3400, 'monthly', '2026-01-06', '20000000-0000-4000-8000-0000000000c2', '20000000-0000-4000-8000-0000000000a1'),
  -- Status only: no account at all.
  ('20000000-0000-4000-8000-0000000000b3', '20000000-0000-4000-8000-000000000001', 'Untracked', 5000, 'monthly', '2026-01-07', null, null),
  -- Status only: the account exists but is archived.
  ('20000000-0000-4000-8000-0000000000b4', '20000000-0000-4000-8000-000000000001', 'Old Account', 7000, 'monthly', '2026-01-08', null, '20000000-0000-4000-8000-0000000000a2');

-- Archived *after* the bill was created, which is the only order the schema
-- permits and also the only order that happens in real life:
-- `assert_bill_refs()` refuses a bill pointed at an already-archived account,
-- but says nothing when the account is archived later. That is exactly the
-- state the status-only fallback exists for -- a bill still naming an account
-- its owner has stopped using. `accounts_guard_update()`'s own rule (a derived
-- balance of exactly zero) is satisfied: this account has no transactions.
update public.accounts set is_archived = true
where id = '20000000-0000-4000-8000-0000000000a2';

insert into public.bill_occurrences (id, user_id, bill_id, due_date, status, amount_cents) values
  -- Deliberately 99_00, not the bill's current 120_00: the generated expense
  -- must take the *occurrence's* amount, and a fixture where the two matched
  -- could not tell the difference.
  ('20000000-0000-4000-8000-0000000000f1', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-0000000000b1', '2026-01-05', 'scheduled', 9900),
  ('20000000-0000-4000-8000-0000000000f2', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-0000000000b1', '2026-02-05', 'scheduled', 12000),
  ('20000000-0000-4000-8000-0000000000f3', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-0000000000b1', '2026-03-05', 'scheduled', 12000),
  ('20000000-0000-4000-8000-0000000000f4', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-0000000000b2', '2026-01-06', 'scheduled', 3400),
  ('20000000-0000-4000-8000-0000000000f5', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-0000000000b3', '2026-01-07', 'scheduled', 5000),
  ('20000000-0000-4000-8000-0000000000f6', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-0000000000b4', '2026-01-08', 'scheduled', 7000),
  ('20000000-0000-4000-8000-0000000000f7', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-0000000000b1', '2026-04-05', 'scheduled', 12000),
  ('20000000-0000-4000-8000-0000000000f8', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-0000000000b1', '2026-05-05', 'scheduled', 12000);

-- One transaction the owner wrote themselves, days before any settlement.
-- Every "a linked transaction is never deleted" assertion is about this row.
insert into public.transactions
  (id, user_id, account_id, date, merchant, kind, category_id, amount_cents, created_at) values
  ('20000000-0000-4000-8000-0000000000d1', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-0000000000a1', '2026-01-04', 'Hand-written payment', 'expense', '20000000-0000-4000-8000-0000000000c1', -8800, '2026-01-04 10:00:00+00');

-- Another owner's transaction, for the cross-owner link refusal.
insert into public.transactions
  (id, user_id, account_id, date, merchant, kind, amount_cents) values
  ('20000000-0000-4000-8000-0000000000d9', '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-0000000000a9', '2026-01-04', 'B payment', 'expense', -1000);

-- One occurrence already paid with a *linked* transaction, seeded directly so
-- the reversal test starts from a state no settle call produced.
insert into public.bill_occurrences
  (id, user_id, bill_id, due_date, status, amount_cents, transaction_id, transaction_origin, paid_on) values
  ('20000000-0000-4000-8000-0000000000fa', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-0000000000b1', '2025-12-05', 'paid', 12000, '20000000-0000-4000-8000-0000000000d1', 'linked', '2026-01-04');

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '20000000-0000-4000-8000-000000000001';

select is((select auth.uid()), '20000000-0000-4000-8000-000000000001'::uuid, 'the claim took effect');

-- ============================================================
-- 1. A projection writes nothing
-- ============================================================

select is(
  (select count(*)::int from public.transactions t
   where t.user_id = '20000000-0000-4000-8000-000000000001'),
  1,
  'the owner starts with exactly the one hand-written transaction'
);

-- Skipping is the operation most easily confused with a payment, and it must
-- stay entirely inert. It also goes through a plain UPDATE rather than either
-- RPC, which is what makes "skip cannot touch the ledger" structural.
select lives_ok(
  $$ update public.bill_occurrences
     set status = 'skipped', paid_on = null, transaction_id = null, transaction_origin = null
     where id = '20000000-0000-4000-8000-0000000000f8' $$,
  'an occurrence can be skipped'
);
select is(
  (select count(*)::int from public.transactions t
   where t.user_id = '20000000-0000-4000-8000-000000000001'),
  1,
  'skipping created no transaction'
);
select is(
  (select transaction_origin::text from public.bill_occurrences
   where id = '20000000-0000-4000-8000-0000000000f8'),
  null,
  'a skipped occurrence carries no payment provenance'
);

-- ============================================================
-- 2a. GENERATED -- the bill names a usable account
-- ============================================================

select is(
  (public.settle_bill_occurrence(
     '20000000-0000-4000-8000-0000000000f1', '2026-01-09', null,
     '20000000-0000-4000-8000-0000000000e1') ->> 'generated')::boolean,
  true,
  'settling a bill with a usable account generates a payment'
);

select is(
  (select amount_cents from public.transactions where id = '20000000-0000-4000-8000-0000000000e1'),
  -9900::bigint,
  'the generated expense carries the OCCURRENCE''s amount, negated -- not the bill''s current 12000'
);
select is(
  (select kind::text from public.transactions where id = '20000000-0000-4000-8000-0000000000e1'),
  'expense',
  'the generated row is an ordinary expense'
);
select is(
  (select account_id from public.transactions where id = '20000000-0000-4000-8000-0000000000e1'),
  '20000000-0000-4000-8000-0000000000a1'::uuid,
  'it lands in the bill''s account'
);
select is(
  (select category_id from public.transactions where id = '20000000-0000-4000-8000-0000000000e1'),
  '20000000-0000-4000-8000-0000000000c1'::uuid,
  'it carries the bill''s category, which is an active expense category'
);
select is(
  (select date from public.transactions where id = '20000000-0000-4000-8000-0000000000e1'),
  '2026-01-09'::date,
  'it is dated the paid date, not the due date'
);
select is(
  (select merchant from public.transactions where id = '20000000-0000-4000-8000-0000000000e1'),
  'Electric',
  'its merchant is the bill''s name, verbatim'
);
select is(
  (select movement_id from public.transactions where id = '20000000-0000-4000-8000-0000000000e1'),
  null,
  'it carries no movement -- it is an ordinary row, reachable from the ordinary surface'
);
select is(
  (select transaction_origin::text from public.bill_occurrences
   where id = '20000000-0000-4000-8000-0000000000f1'),
  'generated',
  'the occurrence records the payment as generated'
);
select is(
  (select balance_cents from public.account_balances
   where id = '20000000-0000-4000-8000-0000000000a1'),
  (500000 - 8800 - 9900)::bigint,
  'the account balance moved by exactly the occurrence amount'
);

-- Idempotency: the same occurrence again, with a *different* key. Nothing is
-- written, and the caller is told the occurrence was already paid.
select is(
  (public.settle_bill_occurrence(
     '20000000-0000-4000-8000-0000000000f1', '2026-01-10', null,
     '20000000-0000-4000-8000-0000000000e2') ->> 'already_paid')::boolean,
  true,
  'settling an already-paid occurrence reports already_paid'
);
select is(
  (select count(*)::int from public.transactions
   where id = '20000000-0000-4000-8000-0000000000e2'),
  0,
  'and writes no second transaction, even under a fresh key'
);
select is(
  (select count(*)::int from public.transactions t
   where t.user_id = '20000000-0000-4000-8000-000000000001'),
  2,
  'the owner has exactly two transactions -- the hand-written one and the generated one'
);

-- ============================================================
-- 2b. GENERATED, uncategorized -- the bill's category cannot label an expense
-- ============================================================
-- A bill's category kind is deliberately unconstrained (CP7); an expense
-- transaction's is not. Dropping the category beats refusing the settlement:
-- an uncategorized expense is legal, visible, and one edit from correct, while
-- a refusal is a dead end over a labelling detail.

select is(
  (public.settle_bill_occurrence(
     '20000000-0000-4000-8000-0000000000f4', '2026-01-09', null,
     '20000000-0000-4000-8000-0000000000e3') ->> 'category_applied')::boolean,
  false,
  'an income category is not applied to a generated expense'
);
select is(
  (select category_id from public.transactions where id = '20000000-0000-4000-8000-0000000000e3'),
  null,
  'the generated row is created uncategorized rather than refused'
);
select is(
  (select amount_cents from public.transactions where id = '20000000-0000-4000-8000-0000000000e3'),
  -3400::bigint,
  'and is otherwise an ordinary expense'
);

-- ============================================================
-- 2c. STATUS ONLY -- no account, or an archived one
-- ============================================================

select is(
  (public.settle_bill_occurrence(
     '20000000-0000-4000-8000-0000000000f5', '2026-01-09', null,
     '20000000-0000-4000-8000-0000000000e4') ->> 'ledger_changed')::boolean,
  false,
  'a bill with no account settles without touching the ledger'
);
select is(
  (select transaction_id from public.bill_occurrences
   where id = '20000000-0000-4000-8000-0000000000f5'),
  null,
  'and records no payment reference'
);
select is(
  (select status::text from public.bill_occurrences
   where id = '20000000-0000-4000-8000-0000000000f5'),
  'paid',
  'but is still marked paid -- the obligation was met'
);

-- An archived account is the same answer, and deliberately not a refusal:
-- assert_transaction_refs() would reject a row posted into one, and blocking
-- the settlement over it would leave a person unable to record a payment they
-- actually made.
select is(
  (public.settle_bill_occurrence(
     '20000000-0000-4000-8000-0000000000f6', '2026-01-09', null,
     '20000000-0000-4000-8000-0000000000e5') ->> 'ledger_changed')::boolean,
  false,
  'an archived account settles status-only rather than refusing'
);
select is(
  (select count(*)::int from public.transactions
   where id = '20000000-0000-4000-8000-0000000000e5'),
  0,
  'and writes nothing into the archived account'
);

-- ============================================================
-- 2d. LINKED -- and the linked transaction is not touched
-- ============================================================

select is(
  (public.settle_bill_occurrence(
     '20000000-0000-4000-8000-0000000000f2', '2026-01-09',
     '20000000-0000-4000-8000-0000000000d1',
     '20000000-0000-4000-8000-0000000000e6') ->> 'generated')::boolean,
  false,
  'supplying a transaction links it instead of generating one'
);
select is(
  (select transaction_origin::text from public.bill_occurrences
   where id = '20000000-0000-4000-8000-0000000000f2'),
  'linked',
  'and records it as linked, never as generated'
);
select is(
  (select amount_cents from public.transactions where id = '20000000-0000-4000-8000-0000000000d1'),
  -8800::bigint,
  'the linked transaction keeps its own amount -- it may differ from the bill''s'
);
select is(
  (select count(*)::int from public.transactions
   where id = '20000000-0000-4000-8000-0000000000e6'),
  0,
  'the unused generated key wrote nothing'
);

select throws_ok(
  $$ select public.settle_bill_occurrence(
       '20000000-0000-4000-8000-0000000000f3', '2026-01-09',
       '20000000-0000-4000-8000-0000000000d9',
       '20000000-0000-4000-8000-0000000000e7') $$,
  '23503', null,
  'linking another owner''s transaction is refused -- their row is invisible through RLS'
);

-- ============================================================
-- 3. Provenance cannot be forged
-- ============================================================
-- The load-bearing security property of the checkpoint. `'generated'` is a
-- claim the database verifies rather than accepts: the referenced
-- transaction's created_at must equal now() -- transaction_timestamp() -- which
-- is true only for a row inserted by the very transaction doing the update.
--
-- It is unforgeable because `authenticated` holds no grant on
-- transactions.created_at, on INSERT or on UPDATE (100-write-grants.sql), so
-- there is no statement available to this role that could manufacture a
-- qualifying row.

select throws_ok(
  $$ update public.bill_occurrences
     set status = 'paid', paid_on = '2026-01-09',
         transaction_id = '20000000-0000-4000-8000-0000000000d1',
         transaction_origin = 'generated'
     where id = '20000000-0000-4000-8000-0000000000f3' $$,
  '23514', null,
  'a pre-existing transaction cannot be relabelled as a generated payment'
);

-- The same statement with the honest label succeeds, which is what proves the
-- refusal above is about provenance and not about the update as a whole.
select lives_ok(
  $$ update public.bill_occurrences
     set status = 'paid', paid_on = '2026-01-09',
         transaction_id = '20000000-0000-4000-8000-0000000000d1',
         transaction_origin = 'linked'
     where id = '20000000-0000-4000-8000-0000000000f3' $$,
  'the same reference is accepted as linked'
);

-- And the column pair is biconditional: a reference without provenance, or
-- provenance without a reference, is not a representable state.
select throws_ok(
  $$ update public.bill_occurrences
     set status = 'paid', paid_on = '2026-01-09',
         transaction_id = '20000000-0000-4000-8000-0000000000d1',
         transaction_origin = null
     where id = '20000000-0000-4000-8000-0000000000f7' $$,
  '23514', null,
  'a payment reference with no provenance is refused'
);

-- ============================================================
-- 4. Reversal is exact
-- ============================================================

-- A generated payment: removed with the occurrence, in one transaction.
select is(
  (public.unsettle_bill_occurrence('20000000-0000-4000-8000-0000000000f1')
     ->> 'removed_transaction')::boolean,
  true,
  'unsettling a generated payment removes the transaction it created'
);
select is(
  (select count(*)::int from public.transactions
   where id = '20000000-0000-4000-8000-0000000000e1'),
  0,
  'the generated row is gone'
);
-- Back to the hand-written expense plus the *other* generated payment (the
-- uncategorized one, 2b), and nothing of this occurrence's. Spelled out rather
-- than written as a single number so the reversal is visibly exact: only the
-- 9900 this settlement created has gone.
select is(
  (select balance_cents from public.account_balances
   where id = '20000000-0000-4000-8000-0000000000a1'),
  (500000 - 8800 - 3400)::bigint,
  'and the account balance is back where it was before this settlement'
);
select is(
  (select status::text || coalesce(transaction_id::text, '-') || coalesce(transaction_origin::text, '-')
   from public.bill_occurrences where id = '20000000-0000-4000-8000-0000000000f1'),
  'scheduled--',
  'the occurrence is scheduled again with every payment field cleared'
);

-- A linked payment: the reference is cleared and the transaction survives.
-- This is the assertion the whole provenance mechanism exists to guarantee.
select is(
  (public.unsettle_bill_occurrence('20000000-0000-4000-8000-0000000000fa')
     ->> 'removed_transaction')::boolean,
  false,
  'unsettling a linked payment removes nothing'
);
select is(
  (select count(*)::int from public.transactions
   where id = '20000000-0000-4000-8000-0000000000d1'),
  1,
  'the owner''s own transaction is still there -- it is never deleted'
);
select is(
  (select amount_cents from public.transactions where id = '20000000-0000-4000-8000-0000000000d1'),
  -8800::bigint,
  'and is byte-for-byte what it was'
);

-- An already-scheduled occurrence: a no-op that deletes nothing.
select is(
  (public.unsettle_bill_occurrence('20000000-0000-4000-8000-0000000000f7')
     ->> 'restored')::boolean,
  false,
  'unsettling a scheduled occurrence is a no-op'
);

-- ============================================================
-- Cross-owner: another owner's occurrence is not addressable
-- ============================================================

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '20000000-0000-4000-8000-000000000002';

select throws_ok(
  $$ select public.settle_bill_occurrence(
       '20000000-0000-4000-8000-0000000000f7', '2026-01-09', null,
       '20000000-0000-4000-8000-0000000000e8') $$,
  '23503', null,
  'owner B cannot settle owner A''s occurrence'
);
select throws_ok(
  $$ select public.unsettle_bill_occurrence('20000000-0000-4000-8000-0000000000f2') $$,
  '23503', null,
  'owner B cannot unsettle owner A''s occurrence -- and so cannot delete A''s transaction'
);

reset role;

select * from finish();
rollback;
