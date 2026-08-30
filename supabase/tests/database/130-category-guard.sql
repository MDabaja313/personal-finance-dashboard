-- guard_category_kind_change(): a category's kind is editable only
-- while the category is completely unreferenced.
--
-- "Referenced" means a row exists in any of transactions.category_id,
-- budgets.category_id, or bills.category_id -- the three columns in
-- this schema that point at a category. Each of the three is proven
-- *in isolation*, on its own category with no rows in the other two:
-- a test that referenced one category from all three tables at once
-- would pass even if the guard only checked one of them.
--
-- Rename and archive must keep working for referenced categories, and
-- that is asserted too. It is the half a careless implementation gets
-- wrong -- freezing the whole row instead of the one column -- and it
-- would strand every category a person has ever used.
--
-- Exercised through `authenticated` throughout, unlike the account
-- guard. Here that is the point: `kind` IS in the CP2 UPDATE grant, so
-- this is a rule the application's own role can actually reach, and
-- the trigger is the only thing standing between a session token and a
-- silent reclassification of months of settled figures. A representative
-- case is repeated as the migration owner at the end, to show the guard
-- is not role-scoped.
begin;
select plan(16);

insert into auth.users (id, aud, role, email) values
  ('21000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'cguard@local.test');
insert into public.profiles (id) values ('21000000-0000-4000-8000-000000000001');

insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('21000000-0000-4000-8000-0000000000a1', '21000000-0000-4000-8000-000000000001', 'Checking', 'Bank', 'checking', 10000);

-- c1: unreferenced.        c2: referenced by a transaction only.
-- c3: referenced by a budget only.   c4: referenced by a bill only.
insert into public.categories (id, user_id, name, kind) values
  ('21000000-0000-4000-8000-0000000000c1', '21000000-0000-4000-8000-000000000001', 'Unused', 'expense'),
  ('21000000-0000-4000-8000-0000000000c2', '21000000-0000-4000-8000-000000000001', 'By transaction', 'expense'),
  ('21000000-0000-4000-8000-0000000000c3', '21000000-0000-4000-8000-000000000001', 'By budget', 'expense'),
  ('21000000-0000-4000-8000-0000000000c4', '21000000-0000-4000-8000-000000000001', 'By bill', 'expense');

insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, amount_cents) values
  ('21000000-0000-4000-8000-000000000101', '21000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-0000000000a1', '2026-01-10', 'x', 'expense', '21000000-0000-4000-8000-0000000000c2', -500);

insert into public.budgets (id, user_id, category_id, period, limit_cents) values
  ('21000000-0000-4000-8000-0000000000b1', '21000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-0000000000c3', '2026-01', 5000);

insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date, category_id) values
  ('21000000-0000-4000-8000-000000000201', '21000000-0000-4000-8000-000000000001', 'Bill', 100, 'monthly', '2026-01-01', '21000000-0000-4000-8000-0000000000c4');

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '21000000-0000-4000-8000-000000000001';

select is(
  (select auth.uid()),
  '21000000-0000-4000-8000-000000000001'::uuid,
  'auth.uid() reflects the request.jwt.claim.sub GUC'
);

-- ============================================================
-- Unreferenced: the kind is editable
-- ============================================================

savepoint kind_free;
select lives_ok(
  $$ update public.categories set kind = 'income'
     where id = '21000000-0000-4000-8000-0000000000c1' $$,
  'the kind of a completely unreferenced category can be changed'
);
select is(
  (select kind::text from public.categories where id = '21000000-0000-4000-8000-0000000000c1'),
  'income',
  'and the change actually landed'
);
select lives_ok(
  $$ update public.categories set name = 'Renamed', kind = 'expense'
     where id = '21000000-0000-4000-8000-0000000000c1' $$,
  'name and kind can change together while the category is unreferenced'
);
rollback to savepoint kind_free;

-- ============================================================
-- Referenced by a transaction only
-- ============================================================

select throws_ok(
  $$ update public.categories set kind = 'income'
     where id = '21000000-0000-4000-8000-0000000000c2' $$,
  '23514',
  null,
  'the kind of a category referenced by a transaction is rejected'
);
select is(
  (select kind::text from public.categories where id = '21000000-0000-4000-8000-0000000000c2'),
  'expense',
  'and its stored kind is untouched'
);

-- ============================================================
-- Referenced by a budget only
-- ============================================================
-- c3 has no transactions at all, so this fails only if the guard checks
-- budgets specifically.

select throws_ok(
  $$ update public.categories set kind = 'income'
     where id = '21000000-0000-4000-8000-0000000000c3' $$,
  '23514',
  null,
  'the kind of a category referenced only by a budget is rejected'
);

-- ============================================================
-- Referenced by a bill only
-- ============================================================
-- Likewise: c4 has neither transactions nor budgets.

select throws_ok(
  $$ update public.categories set kind = 'income'
     where id = '21000000-0000-4000-8000-0000000000c4' $$,
  '23514',
  null,
  'the kind of a category referenced only by a bill is rejected'
);

-- ============================================================
-- Rename and archive stay available to referenced categories
-- ============================================================
-- The rule is scoped to `kind`, not to the row: a category someone has
-- stopped using still needs to be renameable and archivable, while its
-- historical rows keep resolving through it.

savepoint referenced_edits;
select lives_ok(
  $$ update public.categories set name = 'Groceries (old)'
     where id = '21000000-0000-4000-8000-0000000000c2' $$,
  'a referenced category can still be renamed'
);
select is(
  (select name from public.categories where id = '21000000-0000-4000-8000-0000000000c2'),
  'Groceries (old)',
  'and the rename landed'
);
select lives_ok(
  $$ update public.categories set is_archived = true
     where id = '21000000-0000-4000-8000-0000000000c3' $$,
  'a referenced category can still be archived'
);
select lives_ok(
  $$ update public.categories set is_archived = false
     where id = '21000000-0000-4000-8000-0000000000c3' $$,
  'and unarchived'
);
select lives_ok(
  $$ update public.categories set name = 'Renamed too', kind = kind
     where id = '21000000-0000-4000-8000-0000000000c4' $$,
  'writing the same kind back alongside a rename is not a change and is allowed'
);
rollback to savepoint referenced_edits;

-- ============================================================
-- Archived categories stay readable
-- ============================================================
-- The whole reason archival is preferred to deletion: an archived
-- category must keep resolving the label on every historical row that
-- points at it.

savepoint archived_visibility;
update public.categories set is_archived = true
  where id = '21000000-0000-4000-8000-0000000000c2';
select is(
  (select count(*)::int from public.categories
   where id = '21000000-0000-4000-8000-0000000000c2'),
  1,
  'an archived category is still selectable by its owner'
);
rollback to savepoint archived_visibility;

-- ============================================================
-- The guard is not role-scoped
-- ============================================================
-- Same refusal as the migration owner, which holds BYPASSRLS and every
-- column privilege -- so the rule survives any future path that is not
-- `authenticated`.

reset role;

select throws_ok(
  $$ update public.categories set kind = 'income'
     where id = '21000000-0000-4000-8000-0000000000c2' $$,
  '23514',
  null,
  'the migration owner is refused the same reclassification'
);
select lives_ok(
  $$ update public.categories set kind = 'income'
     where id = '21000000-0000-4000-8000-0000000000c1' $$,
  'and is still allowed it on the unreferenced category'
);

select * from finish();
rollback;
