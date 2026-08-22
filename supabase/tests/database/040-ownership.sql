-- Composite FK ownership: a child row referencing another user's parent
-- must be rejected, for every documented composite FK pair. Restrict-
-- style FKs are NO ACTION DEFERRABLE INITIALLY DEFERRED (D10), so the
-- rejection surfaces at COMMIT, not at the statement — each case forces
-- that with SET CONSTRAINTS ALL IMMEDIATE.
begin;
select plan(9);

insert into auth.users (id, aud, role, email) values
  ('12000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'own-a@local.test'),
  ('12000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'own-b@local.test');
insert into public.profiles (id) values
  ('12000000-0000-4000-8000-000000000001'),
  ('12000000-0000-4000-8000-000000000002');

-- User A's parents
insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('12000000-0000-4000-8000-0000000000a1', '12000000-0000-4000-8000-000000000001', 'A-acct', 'Bank', 'checking', 0);
insert into public.categories (id, user_id, name, kind) values
  ('12000000-0000-4000-8000-0000000000c1', '12000000-0000-4000-8000-000000000001', 'A-cat', 'expense');
insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date) values
  ('12000000-0000-4000-8000-0000000000b1', '12000000-0000-4000-8000-000000000001', 'A-bill', 100, 'monthly', '2026-01-01');
insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, amount_cents) values
  ('12000000-0000-4000-8000-000000000f01', '12000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-0000000000a1', '2026-01-01', 'A-txn', 'expense', '12000000-0000-4000-8000-0000000000c1', -100);
insert into public.goals (id, user_id, name, target_cents) values
  ('12000000-0000-4000-8000-000000000f02', '12000000-0000-4000-8000-000000000001', 'A-goal', 1000);

-- User B's own account/category (so User B's own composite FK match is available for negative tests)
insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('12000000-0000-4000-8000-0000000000a2', '12000000-0000-4000-8000-000000000002', 'B-acct', 'Bank', 'checking', 0);
insert into public.categories (id, user_id, name, kind) values
  ('12000000-0000-4000-8000-0000000000c2', '12000000-0000-4000-8000-000000000002', 'B-cat', 'expense');
insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date) values
  ('12000000-0000-4000-8000-0000000000b2', '12000000-0000-4000-8000-000000000002', 'B-bill', 100, 'monthly', '2026-01-01');
insert into public.goals (id, user_id, name, target_cents) values
  ('12000000-0000-4000-8000-000000000f03', '12000000-0000-4000-8000-000000000002', 'B-goal', 1000);

-- transactions(account_id, user_id) -> accounts: User B's row referencing User A's account.
savepoint s1;
insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents) values
  ('12000000-0000-4000-8000-000000010001', '12000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-0000000000a1', '2026-01-01', 'x', 'expense', -100);
select throws_ok(
  $$ set constraints all immediate $$, '23503', null,
  'a transaction referencing another user''s account is rejected'
);
rollback to savepoint s1;
set constraints all deferred;

-- transactions(category_id, user_id) -> categories: User B's row referencing User A's category.
savepoint s2;
insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, amount_cents) values
  ('12000000-0000-4000-8000-000000010002', '12000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-0000000000a2', '2026-01-01', 'x', 'expense', '12000000-0000-4000-8000-0000000000c1', -100);
select throws_ok(
  $$ set constraints all immediate $$, '23503', null,
  'a transaction referencing another user''s category is rejected'
);
rollback to savepoint s2;
set constraints all deferred;

-- budgets(category_id, user_id) -> categories
savepoint s3;
insert into public.budgets (id, user_id, category_id, period, limit_cents) values
  ('12000000-0000-4000-8000-000000010003', '12000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-0000000000c1', '2026-08', 1000);
select throws_ok(
  $$ set constraints all immediate $$, '23503', null,
  'a budget referencing another user''s category is rejected'
);
rollback to savepoint s3;
set constraints all deferred;

-- bills(category_id, user_id) -> categories
savepoint s4;
insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date, category_id) values
  ('12000000-0000-4000-8000-000000010004', '12000000-0000-4000-8000-000000000002', 'x', 100, 'monthly', '2026-01-01', '12000000-0000-4000-8000-0000000000c1');
select throws_ok(
  $$ set constraints all immediate $$, '23503', null,
  'a bill referencing another user''s category is rejected'
);
rollback to savepoint s4;
set constraints all deferred;

-- bills(account_id, user_id) -> accounts
savepoint s5;
insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date, account_id) values
  ('12000000-0000-4000-8000-000000010005', '12000000-0000-4000-8000-000000000002', 'x', 100, 'monthly', '2026-01-01', '12000000-0000-4000-8000-0000000000a1');
select throws_ok(
  $$ set constraints all immediate $$, '23503', null,
  'a bill referencing another user''s account is rejected'
);
rollback to savepoint s5;
set constraints all deferred;

-- bill_occurrences(bill_id, user_id) -> bills
savepoint s6;
insert into public.bill_occurrences (id, user_id, bill_id, due_date, status, amount_cents) values
  ('12000000-0000-4000-8000-000000010006', '12000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-0000000000b1', '2026-01-01', 'scheduled', 100);
select throws_ok(
  $$ set constraints all immediate $$, '23503', null,
  'a bill occurrence referencing another user''s bill is rejected'
);
rollback to savepoint s6;
set constraints all deferred;

-- bill_occurrences(transaction_id, user_id) -> transactions
savepoint s7;
insert into public.bill_occurrences (id, user_id, bill_id, due_date, status, amount_cents, transaction_id, paid_on) values
  ('12000000-0000-4000-8000-000000010007', '12000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-0000000000b2', '2026-01-01', 'paid', 100, '12000000-0000-4000-8000-000000000f01', '2026-01-01');
select throws_ok(
  $$ set constraints all immediate $$, '23503', null,
  'a bill occurrence referencing another user''s transaction is rejected'
);
rollback to savepoint s7;
set constraints all deferred;

-- goal_contributions(goal_id, user_id) -> goals
savepoint s8;
insert into public.goal_contributions (id, user_id, goal_id, amount_cents, occurred_on) values
  ('12000000-0000-4000-8000-000000010008', '12000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-000000000f02', 100, '2026-01-01');
select throws_ok(
  $$ set constraints all immediate $$, '23503', null,
  'a goal contribution referencing another user''s goal is rejected'
);
rollback to savepoint s8;
set constraints all deferred;

-- Positive control: User B referencing User B's own parents is legal.
savepoint s9;
select lives_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, amount_cents) values ('12000000-0000-4000-8000-000000010009', '12000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-0000000000a2', '2026-01-01', 'x', 'expense', '12000000-0000-4000-8000-0000000000c2', -100) $$,
  'a transaction referencing the SAME user''s own account and category is legal'
);
rollback to savepoint s9;

-- No finish() -- see 020-movements.sql.
rollback;
