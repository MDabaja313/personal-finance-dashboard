-- Write-side Row Level Security for the two tables CP2 opened.
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
select plan(28);

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
  ('19000000-0000-4000-8000-0000000000a2', '19000000-0000-4000-8000-000000000002', 'B-acct', 'Bank', 'checking', 2000);

insert into public.categories (id, user_id, name, kind) values
  ('19000000-0000-4000-8000-0000000000c1', '19000000-0000-4000-8000-000000000001', 'A-cat', 'expense'),
  ('19000000-0000-4000-8000-0000000000c2', '19000000-0000-4000-8000-000000000002', 'B-cat', 'expense');

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
  2,
  'the account A inserted is present and visible to A (and B''s still is not)'
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

-- ============================================================
-- Final state, seen without RLS
-- ============================================================

reset role;

select is(
  (select count(*)::int from public.accounts
   where user_id = '19000000-0000-4000-8000-000000000001'),
  2,
  'owner A ends with exactly the two accounts it is entitled to'
);
select is(
  (select count(*)::int from public.accounts
   where user_id = '19000000-0000-4000-8000-000000000002'),
  1,
  'owner B ends with exactly its one account -- nothing was created for or moved to B'
);

select * from finish();
rollback;
