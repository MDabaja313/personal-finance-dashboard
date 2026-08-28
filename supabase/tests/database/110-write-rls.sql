-- Write-side Row Level Security for the three writable tables --
-- accounts and categories from CP2, transactions from CP3.
--
-- 100-write-grants.sql proves *which operations and columns* exist as
-- privileges. This file proves *which rows* those privileges can reach,
-- by running real statements as `authenticated` with two different
-- verified-claim uids and as `anon`.
--
-- Both halves are needed and neither implies the other: a GRANT with no
-- policy would let a permitted write match zero rows silently, and a
-- policy with no GRANT would never be consulted at all. The two failure
-- modes even look different, which is why this file distinguishes them
-- deliberately:
--
--   * A GRANT-layer refusal raises 42501 before RLS is consulted --
--     that is what an ungranted column or a DELETE attempt gets.
--   * An INSERT whose row fails a WITH CHECK also raises 42501
--     ("new row violates row-level security policy"), because the
--     database refuses to write a row it would not let you see.
--   * An UPDATE whose target fails the USING predicate raises nothing
--     at all: the row is simply invisible, so the statement matches
--     zero rows and succeeds. That is the dangerous case -- it looks
--     like it worked -- so it is asserted by checking the *other
--     owner's row afterwards*, from a role that can actually see it,
--     rather than by trusting the absence of an error.
--
-- Fixture setup runs as the migration owner (postgres, BYPASSRLS), the
-- same arrangement 020/030/040/050/060 use.
begin;
select plan(57);

-- ============================================================
-- Fixture: two owners, one account and one category each
-- ============================================================

insert into auth.users (id, aud, role, email) values
  ('19000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'wrls-a@local.test'),
  ('19000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'wrls-b@local.test');
insert into public.profiles (id) values
  ('19000000-0000-4000-8000-000000000001'),
  ('19000000-0000-4000-8000-000000000002');

insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('19000000-0000-4000-8000-0000000000a1', '19000000-0000-4000-8000-000000000001', 'A-acct', 'Bank', 'checking', 1000),
  ('19000000-0000-4000-8000-0000000000a3', '19000000-0000-4000-8000-000000000001', 'A-acct-2', 'Bank', 'savings', 0),
  ('19000000-0000-4000-8000-0000000000a2', '19000000-0000-4000-8000-000000000002', 'B-acct', 'Bank', 'checking', 2000);

-- A gets two categories, and the split is load-bearing: `A-cat` must stay
-- completely unreferenced, because the assertion below retypes it and
-- guard_category_kind_change() freezes a category's kind the moment
-- anything points at it. The transaction fixtures therefore use
-- `A-txn-cat` instead.
insert into public.categories (id, user_id, name, kind) values
  ('19000000-0000-4000-8000-0000000000c1', '19000000-0000-4000-8000-000000000001', 'A-cat', 'expense'),
  ('19000000-0000-4000-8000-0000000000c3', '19000000-0000-4000-8000-000000000001', 'A-txn-cat', 'expense'),
  ('19000000-0000-4000-8000-0000000000c2', '19000000-0000-4000-8000-000000000002', 'B-cat', 'expense');

-- Transaction fixtures. Dated in the past so the posted-date ceiling in
-- assert_transaction_refs() is never the thing under test here -- that
-- rule has 135-posted-ledger.sql to itself.
--
--   ...f1  A's ordinary expense        -- editable, deletable
--   ...f2  B's ordinary expense        -- A must not reach it
--   ...ad  A's adjustment              -- readable, deletable, never editable
--   ...b1/...b2  A's two transfer legs -- readable, never editable or deletable
insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, amount_cents) values
  ('19000000-0000-4000-8000-0000000000f1', '19000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-0000000000a1', '2026-01-10', 'A-txn', 'expense', '19000000-0000-4000-8000-0000000000c3', -100),
  ('19000000-0000-4000-8000-0000000000f2', '19000000-0000-4000-8000-000000000002', '19000000-0000-4000-8000-0000000000a2', '2026-01-10', 'B-txn', 'expense', '19000000-0000-4000-8000-0000000000c2', -200);

-- The row only CP5's reconciliation will ever create. Inserted here as
-- the migration owner precisely because `authenticated` cannot: the
-- point of the assertions below is that it cannot *edit* one either.
insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents) values
  ('19000000-0000-4000-8000-0000000000ad', '19000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-0000000000a1', '2026-01-11', 'Reconciliation', 'adjustment', -50);

insert into public.movements (id, user_id, kind) values
  ('19000000-0000-4000-8000-0000000000e1', '19000000-0000-4000-8000-000000000001', 'transfer');
insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values
  ('19000000-0000-4000-8000-0000000000b1', '19000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-0000000000a1', '2026-01-12', 'out', 'transfer', '19000000-0000-4000-8000-0000000000e1', -300),
  ('19000000-0000-4000-8000-0000000000b2', '19000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-0000000000a3', '2026-01-12', 'in', 'transfer', '19000000-0000-4000-8000-0000000000e1', 300);

-- ============================================================
-- As authenticated, claiming owner A
-- ============================================================

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '19000000-0000-4000-8000-000000000001';

select is(
  (select auth.uid()),
  '19000000-0000-4000-8000-000000000001'::uuid,
  'auth.uid() reflects the request.jwt.claim.sub GUC for owner A'
);

-- ---------- INSERT ----------

select lives_ok(
  $$ insert into public.accounts (user_id, name, institution, type, opening_balance_cents)
     values ('19000000-0000-4000-8000-000000000001', 'A-new', 'Bank', 'savings', 500) $$,
  'A can INSERT an account for itself'
);
select is(
  (select count(*)::int from public.accounts),
  3,
  'the account A inserted is present and visible to A alongside its two fixtures (and B''s still is not)'
);

select throws_ok(
  $$ insert into public.accounts (user_id, name, institution, type, opening_balance_cents)
     values ('19000000-0000-4000-8000-000000000002', 'stolen', 'Bank', 'savings', 500) $$,
  '42501',
  null,
  'A cannot INSERT an account owned by B -- the WITH CHECK refuses the row'
);

select lives_ok(
  $$ insert into public.categories (user_id, name, kind)
     values ('19000000-0000-4000-8000-000000000001', 'A-new-cat', 'income') $$,
  'A can INSERT a category for itself'
);
select throws_ok(
  $$ insert into public.categories (user_id, name, kind)
     values ('19000000-0000-4000-8000-000000000002', 'stolen-cat', 'income') $$,
  '42501',
  null,
  'A cannot INSERT a category owned by B -- the WITH CHECK refuses the row'
);

-- ---------- UPDATE, own rows ----------

select lives_ok(
  $$ update public.accounts set name = 'A-renamed', institution = 'New Bank'
     where id = '19000000-0000-4000-8000-0000000000a1' $$,
  'A can UPDATE the granted metadata columns on its own account'
);
select is(
  (select name from public.accounts where id = '19000000-0000-4000-8000-0000000000a1'),
  'A-renamed',
  'the rename actually took effect on A''s own account'
);
select lives_ok(
  $$ update public.accounts set is_archived = false
     where id = '19000000-0000-4000-8000-0000000000a1' $$,
  'A can UPDATE is_archived on its own account (no false -> true transition here)'
);
select lives_ok(
  $$ update public.categories set name = 'A-cat-renamed', kind = 'income'
     where id = '19000000-0000-4000-8000-0000000000c1' $$,
  'A can rename and retype its own unreferenced category'
);

-- ---------- UPDATE, foreign rows ----------
-- No error: the USING predicate makes B's row invisible, so these match
-- zero rows. Whether they changed anything is checked below, as B.

select lives_ok(
  $$ update public.accounts set name = 'hijacked'
     where id = '19000000-0000-4000-8000-0000000000a2' $$,
  'A''s UPDATE targeting B''s account raises nothing -- the row is simply invisible'
);
select lives_ok(
  $$ update public.categories set name = 'hijacked'
     where id = '19000000-0000-4000-8000-0000000000c2' $$,
  'A''s UPDATE targeting B''s category raises nothing -- the row is simply invisible'
);

-- ---------- Ownership reassignment and other ungranted columns ----------
-- These fail at the GRANT layer, before RLS: the column is not in the
-- UPDATE grant at all, which is why re-homing a row is unreachable
-- rather than merely policy-checked.

select throws_ok(
  $$ update public.accounts set user_id = '19000000-0000-4000-8000-000000000002'
     where id = '19000000-0000-4000-8000-0000000000a1' $$,
  '42501', null,
  'A cannot reassign its own account''s user_id'
);
select throws_ok(
  $$ update public.categories set user_id = '19000000-0000-4000-8000-000000000002'
     where id = '19000000-0000-4000-8000-0000000000c1' $$,
  '42501', null,
  'A cannot reassign its own category''s user_id'
);
select throws_ok(
  $$ update public.accounts set type = 'savings'
     where id = '19000000-0000-4000-8000-0000000000a1' $$,
  '42501', null,
  'A cannot UPDATE accounts.type -- not in the grant'
);
select throws_ok(
  $$ update public.accounts set created_at = now()
     where id = '19000000-0000-4000-8000-0000000000a1' $$,
  '42501', null,
  'A cannot UPDATE accounts.created_at -- not in the grant'
);
select throws_ok(
  $$ update public.categories set id = '19000000-0000-4000-8000-0000000000cf'
     where id = '19000000-0000-4000-8000-0000000000c1' $$,
  '42501', null,
  'A cannot UPDATE categories.id -- not in the grant'
);

-- ---------- DELETE ----------
-- Neither table has a DELETE grant: both are archived, never removed.

select throws_ok(
  $$ delete from public.accounts where id = '19000000-0000-4000-8000-0000000000a1' $$,
  '42501', null,
  'A cannot DELETE its own account'
);
select throws_ok(
  $$ delete from public.categories where id = '19000000-0000-4000-8000-0000000000c1' $$,
  '42501', null,
  'A cannot DELETE its own category'
);

-- ============================================================
-- transactions: the CP3 surface, still as owner A
-- ============================================================
-- Three policies, and each is exercised for what it permits *and* for
-- what it refuses. The refusals come in two shapes and the distinction
-- matters throughout:
--
--   * An INSERT whose row fails WITH CHECK raises 42501 -- the database
--     refuses to write a row it would not let you see.
--   * An UPDATE or DELETE whose target fails USING raises *nothing*:
--     the row is simply invisible, so the statement matches zero rows
--     and succeeds. That is the dangerous shape, because it looks like
--     it worked, so every one of those is asserted by re-reading the
--     row afterwards rather than by trusting the absence of an error.

-- ---------- INSERT ----------

select lives_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, movement_id, amount_cents)
     values ('19000000-0000-4000-8000-0000000000f3', '19000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-0000000000a1', '2026-01-13', 'A-new-txn', 'expense', '19000000-0000-4000-8000-0000000000c3', null, -400) $$,
  'A can INSERT an ordinary transaction for itself, choosing its own id'
);
select is(
  (select merchant from public.transactions where id = '19000000-0000-4000-8000-0000000000f3'),
  'A-new-txn',
  'the transaction A inserted is present and visible to A'
);

select throws_ok(
  $$ insert into public.transactions (user_id, account_id, date, merchant, kind, amount_cents)
     values ('19000000-0000-4000-8000-000000000002', '19000000-0000-4000-8000-0000000000a2', '2026-01-13', 'stolen', 'expense', -100) $$,
  '42501',
  null,
  'A cannot INSERT a transaction owned by B -- the WITH CHECK refuses the row'
);

-- The same id twice is a primary-key collision, which is exactly what
-- the client-generated idempotency key relies on: a retry cannot become
-- a second row.
select throws_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents)
     values ('19000000-0000-4000-8000-0000000000f3', '19000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-0000000000a1', '2026-01-13', 'A-new-txn', 'expense', -400) $$,
  '23505',
  null,
  'reusing an id collides on the primary key -- the basis of the idempotency contract'
);
select is(
  (select count(*)::int from public.transactions where id = '19000000-0000-4000-8000-0000000000f3'),
  1,
  'the collision left exactly one row, not two'
);

-- ---------- UPDATE, own ordinary row ----------

select lives_ok(
  $$ update public.transactions
     -- Positive, because a refund is: transactions_sign_by_kind_ck is
     -- unchanged for the ordinary kinds, and this statement changes the
     -- kind, so the amount has to move with it.
     set merchant = 'A-renamed', amount_cents = 150, kind = 'refund', category_id = '19000000-0000-4000-8000-0000000000c3',
         date = '2026-01-09', account_id = '19000000-0000-4000-8000-0000000000a3'
     where id = '19000000-0000-4000-8000-0000000000f1' $$,
  'A can UPDATE every granted column on its own ordinary transaction'
);
select is(
  (select merchant from public.transactions where id = '19000000-0000-4000-8000-0000000000f1'),
  'A-renamed',
  'the edit actually took effect on A''s own transaction'
);
select is(
  (select account_id from public.transactions where id = '19000000-0000-4000-8000-0000000000f1'),
  '19000000-0000-4000-8000-0000000000a3'::uuid,
  'moving a transaction between the owner''s own accounts is permitted'
);

-- ---------- UPDATE, foreign row ----------

select lives_ok(
  $$ update public.transactions set merchant = 'hijacked'
     where id = '19000000-0000-4000-8000-0000000000f2' $$,
  'A''s UPDATE targeting B''s transaction raises nothing -- the row is simply invisible'
);

-- ---------- UPDATE, adjustment ----------
-- Both directions. USING refuses to let an existing adjustment be
-- targeted at all; WITH CHECK refuses to let an ordinary row become
-- one, which is what stops the edit form from being a two-step path to
-- writing a CP5 row.

select lives_ok(
  $$ update public.transactions set merchant = 'edited-adjustment'
     where id = '19000000-0000-4000-8000-0000000000ad' $$,
  'A''s UPDATE targeting its own adjustment raises nothing -- USING makes it invisible'
);
select is(
  (select merchant from public.transactions where id = '19000000-0000-4000-8000-0000000000ad'),
  'Reconciliation',
  'and it changed nothing: the adjustment''s merchant is untouched'
);

select throws_ok(
  $$ update public.transactions set kind = 'adjustment', category_id = null
     where id = '19000000-0000-4000-8000-0000000000f1' $$,
  '42501',
  null,
  'A cannot retype an ordinary transaction into an adjustment -- the WITH CHECK refuses the new row'
);
select is(
  (select kind::text from public.transactions where id = '19000000-0000-4000-8000-0000000000f1'),
  'refund',
  'and the ordinary row keeps the kind it had'
);

-- ---------- UPDATE and DELETE, movement legs ----------
-- A leg is invisible to both statements, so neither errors and neither
-- does anything. Removing one half of a transfer would strand the other
-- and leave the movement invalid; editing one would half-rewrite it.

select lives_ok(
  $$ update public.transactions set merchant = 'hijacked-leg', amount_cents = -1
     where id = '19000000-0000-4000-8000-0000000000b1' $$,
  'A''s UPDATE targeting its own movement leg raises nothing -- USING makes it invisible'
);
select is(
  (select merchant || ':' || amount_cents from public.transactions where id = '19000000-0000-4000-8000-0000000000b1'),
  'out:-300',
  'and it changed nothing: the leg''s merchant and amount are untouched'
);

select lives_ok(
  $$ delete from public.transactions where id = '19000000-0000-4000-8000-0000000000b1' $$,
  'A''s DELETE targeting its own movement leg raises nothing -- USING makes it invisible'
);
select is(
  (select count(*)::int from public.transactions where movement_id = '19000000-0000-4000-8000-0000000000e1'),
  2,
  'and it deleted nothing: the movement still has both of its legs'
);

-- ---------- Ungranted columns ----------
-- These fail at the GRANT layer, before RLS: the column is not in the
-- UPDATE grant at all.

select throws_ok(
  $$ update public.transactions set user_id = '19000000-0000-4000-8000-000000000002'
     where id = '19000000-0000-4000-8000-0000000000f1' $$,
  '42501', null,
  'A cannot reassign its own transaction''s user_id'
);
select throws_ok(
  $$ update public.transactions set movement_id = '19000000-0000-4000-8000-0000000000e1'
     where id = '19000000-0000-4000-8000-0000000000f1' $$,
  '42501', null,
  'A cannot adopt its own ordinary transaction into a movement'
);

-- ---------- DELETE, own ordinary and adjustment rows ----------

select lives_ok(
  $$ delete from public.transactions where id = '19000000-0000-4000-8000-0000000000f3' $$,
  'A can DELETE its own ordinary transaction'
);
select is(
  (select count(*)::int from public.transactions where id = '19000000-0000-4000-8000-0000000000f3'),
  0,
  'and the row is actually gone'
);

-- Adjustments are deletable even though they are not editable. CP5's
-- reconciliation is delete-and-rewrite: a superseded adjustment must be
-- removable, or re-reconciling an account would stack adjustments on top
-- of each other forever.
select lives_ok(
  $$ delete from public.transactions where id = '19000000-0000-4000-8000-0000000000ad' $$,
  'A can DELETE its own adjustment -- delete-and-rewrite is how CP5 will reconcile'
);

select lives_ok(
  $$ delete from public.transactions where id = '19000000-0000-4000-8000-0000000000f2' $$,
  'A''s DELETE targeting B''s transaction raises nothing -- the row is simply invisible'
);

-- ============================================================
-- As authenticated, claiming owner B: the decisive check
-- ============================================================
-- A's two foreign UPDATEs raised nothing. This is what proves they also
-- did nothing -- read from the one role that can actually see the rows.

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '19000000-0000-4000-8000-000000000002';

select is(
  (select name from public.accounts where id = '19000000-0000-4000-8000-0000000000a2'),
  'B-acct',
  'B''s account name is untouched by A''s UPDATE'
);
select is(
  (select name from public.categories where id = '19000000-0000-4000-8000-0000000000c2'),
  'B-cat',
  'B''s category name is untouched by A''s UPDATE'
);
select is(
  (select count(*)::int from public.accounts),
  1,
  'B still sees exactly one account -- A''s inserted row is not visible to B'
);

-- A's UPDATE and DELETE against B's transaction both raised nothing.
-- This is what proves they also *did* nothing.
select is(
  (select merchant from public.transactions where id = '19000000-0000-4000-8000-0000000000f2'),
  'B-txn',
  'B''s transaction is untouched by A''s UPDATE'
);
select is(
  (select count(*)::int from public.transactions),
  1,
  'B still sees exactly its one transaction -- A''s DELETE removed nothing'
);

-- ============================================================
-- anon: no write reaches either table
-- ============================================================
-- No claim is set: anon holds no grant of any kind, so the request
-- never reaches RLS.

reset role;
set local role anon;

select throws_ok(
  $$ insert into public.accounts (user_id, name, institution, type, opening_balance_cents)
     values ('19000000-0000-4000-8000-000000000001', 'x', 'Bank', 'checking', 0) $$,
  '42501', null, 'anon cannot INSERT an account'
);
select throws_ok(
  $$ update public.accounts set name = 'x' where id = '19000000-0000-4000-8000-0000000000a1' $$,
  '42501', null, 'anon cannot UPDATE an account'
);
select throws_ok(
  $$ insert into public.categories (user_id, name, kind)
     values ('19000000-0000-4000-8000-000000000001', 'x', 'expense') $$,
  '42501', null, 'anon cannot INSERT a category'
);
select throws_ok(
  $$ update public.categories set name = 'x' where id = '19000000-0000-4000-8000-0000000000c1' $$,
  '42501', null, 'anon cannot UPDATE a category'
);

-- transactions is the first table in this schema where DELETE is
-- granted to anybody, so anon's exclusion from it is stated explicitly
-- rather than left to the catalog sweep in 100-write-grants.sql.
select throws_ok(
  $$ insert into public.transactions (user_id, account_id, date, merchant, kind, amount_cents)
     values ('19000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-0000000000a1', '2026-01-13', 'x', 'expense', -1) $$,
  '42501', null, 'anon cannot INSERT a transaction'
);
select throws_ok(
  $$ update public.transactions set merchant = 'x' where id = '19000000-0000-4000-8000-0000000000f1' $$,
  '42501', null, 'anon cannot UPDATE a transaction'
);
select throws_ok(
  $$ delete from public.transactions where id = '19000000-0000-4000-8000-0000000000f1' $$,
  '42501', null, 'anon cannot DELETE a transaction'
);

-- ============================================================
-- Final state, seen without RLS
-- ============================================================

reset role;

select is(
  (select count(*)::int from public.accounts
   where user_id = '19000000-0000-4000-8000-000000000001'),
  3,
  'owner A ends with exactly the three accounts it is entitled to'
);
select is(
  (select count(*)::int from public.accounts
   where user_id = '19000000-0000-4000-8000-000000000002'),
  1,
  'owner B ends with exactly its one account -- nothing was created for or moved to B'
);

-- A's ledger, counted without RLS: the ordinary row it edited, plus both
-- movement legs it could not delete. The adjustment and the row it
-- created-then-deleted are gone; nothing of B's moved across.
select is(
  (select count(*)::int from public.transactions
   where user_id = '19000000-0000-4000-8000-000000000001'),
  3,
  'owner A ends with its one edited ordinary row and both intact movement legs'
);

select * from finish();
rollback;
