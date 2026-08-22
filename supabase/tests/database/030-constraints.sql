-- Single-row CHECK constraints on transactions, accounts, budgets,
-- goals, bill_occurrences, net_worth_snapshots, and the case-insensitive
-- category uniqueness expression index. Each case uses its own
-- SAVEPOINT so a rejected insert doesn't abort later cases.
begin;
select plan(23);

insert into auth.users (id, aud, role, email) values
  ('11000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ck-test@local.test');
insert into public.profiles (id) values ('11000000-0000-4000-8000-000000000001');
insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('11000000-0000-4000-8000-0000000000a1', '11000000-0000-4000-8000-000000000001', 'A1', 'Bank', 'checking', 0);
insert into public.categories (id, user_id, name, kind) values
  ('11000000-0000-4000-8000-0000000000e1', '11000000-0000-4000-8000-000000000001', 'Groceries', 'expense');

-- transactions_sign_by_kind_ck: expense may be zero (non-strict).
savepoint s1;
select lives_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, amount_cents) values ('11000000-0000-4000-8000-000000010001', '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-0000000000a1', '2026-01-01', 'x', 'expense', '11000000-0000-4000-8000-0000000000e1', 0) $$,
  'a zero-amount expense is legal (non-strict sign check)'
);
rollback to savepoint s1;

savepoint s2;
select throws_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, amount_cents) values ('11000000-0000-4000-8000-000000010002', '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-0000000000a1', '2026-01-01', 'x', 'expense', '11000000-0000-4000-8000-0000000000e1', 100) $$,
  '23514',
  null,
  'a positive-amount expense is rejected'
);
rollback to savepoint s2;

savepoint s3;
select throws_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, amount_cents) values ('11000000-0000-4000-8000-000000010003', '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-0000000000a1', '2026-01-01', 'x', 'income', '11000000-0000-4000-8000-0000000000e1', -100) $$,
  '23514',
  null,
  'a negative-amount income is rejected'
);
rollback to savepoint s3;

-- transactions_movement_nonzero_ck
savepoint s4;
select throws_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values ('11000000-0000-4000-8000-000000010004', '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-0000000000a1', '2026-01-01', 'x', 'transfer', null, 0) $$,
  '23514',
  null,
  'a zero-amount transfer leg is rejected (would also fail the biconditional, but nonzero applies)'
);
rollback to savepoint s4;

-- transactions_movement_biconditional_ck
savepoint s5;
select lives_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, movement_id, amount_cents) values ('11000000-0000-4000-8000-000000010005', '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-0000000000a1', '2026-01-01', 'x', 'expense', null, -100) $$,
  'an ordinary expense with no category is legal (uncategorized is allowed)'
);
rollback to savepoint s5;

savepoint s6;
select lives_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents) values ('11000000-0000-4000-8000-000000010006', '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-0000000000a1', '2026-01-01', 'x', 'income', 100) $$,
  'income legally omits movement_id -- the biconditional only requires it for transfer/credit_card_payment kinds'
);
rollback to savepoint s6;

-- transactions_movement_no_category_ck
savepoint s7;
insert into public.movements (id, user_id, kind) values ('11000000-0000-4000-8000-000000010009', '11000000-0000-4000-8000-000000000001', 'transfer');
select throws_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, category_id, movement_id, amount_cents) values ('11000000-0000-4000-8000-000000010007', '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-0000000000a1', '2026-01-01', 'x', 'transfer', '11000000-0000-4000-8000-0000000000e1', '11000000-0000-4000-8000-000000010009', -100) $$,
  '23514',
  null,
  'a movement leg with a category_id is rejected'
);
rollback to savepoint s7;

-- accounts: credit_limit_cents only for credit type
savepoint s8;
select throws_ok(
  $$ insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents, credit_limit_cents) values ('11000000-0000-4000-8000-0000000000a2', '11000000-0000-4000-8000-000000000001', 'X', 'Bank', 'checking', 0, 1000) $$,
  '23514',
  null,
  'credit_limit_cents on a non-credit account is rejected'
);
rollback to savepoint s8;

savepoint s9;
select throws_ok(
  $$ insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents, credit_limit_cents) values ('11000000-0000-4000-8000-0000000000a3', '11000000-0000-4000-8000-000000000001', 'X', 'Bank', 'credit', 0, -1000) $$,
  '23514',
  null,
  'a negative credit_limit_cents is rejected'
);
rollback to savepoint s9;

-- accounts: interest_rate_bps only for credit/loan
savepoint s10;
select throws_ok(
  $$ insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents, interest_rate_bps) values ('11000000-0000-4000-8000-0000000000a4', '11000000-0000-4000-8000-000000000001', 'X', 'Bank', 'savings', 0, 500) $$,
  '23514',
  null,
  'interest_rate_bps on a savings account is rejected'
);
rollback to savepoint s10;

-- budgets: limit_cents >= 0, period format
savepoint s11;
select throws_ok(
  $$ insert into public.budgets (id, user_id, category_id, period, limit_cents) values ('11000000-0000-4000-8000-0000000000b1', '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-0000000000e1', '2026-08', -1) $$,
  '23514',
  null,
  'a negative budget limit_cents is rejected'
);
rollback to savepoint s11;

savepoint s12;
select throws_ok(
  $$ insert into public.budgets (id, user_id, category_id, period, limit_cents) values ('11000000-0000-4000-8000-0000000000b2', '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-0000000000e1', '2026-13', 1000) $$,
  '23514',
  null,
  'month 13 is rejected by the period format check'
);
rollback to savepoint s12;

savepoint s13;
select throws_ok(
  $$ insert into public.budgets (id, user_id, category_id, period, limit_cents) values ('11000000-0000-4000-8000-0000000000b3', '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-0000000000e1', '2026-00', 1000) $$,
  '23514',
  null,
  'month 00 is rejected by the period format check'
);
rollback to savepoint s13;

-- goals: target_cents > 0
savepoint s14;
select throws_ok(
  $$ insert into public.goals (id, user_id, name, target_cents) values ('11000000-0000-4000-8000-00000001000a', '11000000-0000-4000-8000-000000000001', 'X', 0) $$,
  '23514',
  null,
  'a zero target_cents goal is rejected'
);
rollback to savepoint s14;

-- bill_occurrences status matrix
savepoint s15;
insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date) values
  ('11000000-0000-4000-8000-00000001000b', '11000000-0000-4000-8000-000000000001', 'Bill', 100, 'monthly', '2026-01-01');
select lives_ok(
  $$ insert into public.bill_occurrences (id, user_id, bill_id, due_date, status, amount_cents) values ('11000000-0000-4000-8000-00000001000c', '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-00000001000b', '2026-01-01', 'scheduled', 100) $$,
  'a scheduled occurrence with no payment fields is legal'
);
rollback to savepoint s15;

savepoint s16;
insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date) values
  ('11000000-0000-4000-8000-00000001000b', '11000000-0000-4000-8000-000000000001', 'Bill', 100, 'monthly', '2026-01-01');
select throws_ok(
  $$ insert into public.bill_occurrences (id, user_id, bill_id, due_date, status, amount_cents, paid_on) values ('11000000-0000-4000-8000-00000001000d', '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-00000001000b', '2026-01-01', 'scheduled', 100, '2026-01-01') $$,
  '23514',
  null,
  'a scheduled occurrence with paid_on set is rejected'
);
rollback to savepoint s16;

savepoint s17;
insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date) values
  ('11000000-0000-4000-8000-00000001000b', '11000000-0000-4000-8000-000000000001', 'Bill', 100, 'monthly', '2026-01-01');
select lives_ok(
  $$ insert into public.bill_occurrences (id, user_id, bill_id, due_date, status, amount_cents, paid_on) values ('11000000-0000-4000-8000-00000001000e', '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-00000001000b', '2026-01-01', 'paid', 100, '2026-01-01') $$,
  'a paid occurrence with paid_on set and no transaction_id is legal'
);
rollback to savepoint s17;

savepoint s18;
insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date) values
  ('11000000-0000-4000-8000-00000001000b', '11000000-0000-4000-8000-000000000001', 'Bill', 100, 'monthly', '2026-01-01');
select throws_ok(
  $$ insert into public.bill_occurrences (id, user_id, bill_id, due_date, status, amount_cents) values ('11000000-0000-4000-8000-00000001000f', '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-00000001000b', '2026-01-01', 'paid', 100) $$,
  '23514',
  null,
  'a paid occurrence with no paid_on is rejected'
);
rollback to savepoint s18;

-- net_worth_snapshots identity and format
savepoint s19;
select throws_ok(
  $$ insert into public.net_worth_snapshots (user_id, month, assets_cents, liabilities_cents, net_worth_cents) values ('11000000-0000-4000-8000-000000000001', '2026-01', 100, 50, 40) $$,
  '23514',
  null,
  'net_worth_cents not equal to assets - liabilities is rejected'
);
rollback to savepoint s19;

savepoint s20;
select throws_ok(
  $$ insert into public.net_worth_snapshots (user_id, month, assets_cents, liabilities_cents, net_worth_cents) values ('11000000-0000-4000-8000-000000000001', '2026-01', -1, 0, -1) $$,
  '23514',
  null,
  'negative assets_cents is rejected'
);
rollback to savepoint s20;

-- case-insensitive category uniqueness (unique expression index)
savepoint s21;
select lives_ok(
  $$ insert into public.categories (id, user_id, name, kind) values ('11000000-0000-4000-8000-0000000000e2', '11000000-0000-4000-8000-000000000001', 'Dining', 'expense') $$,
  'first "Dining" category is legal'
);
select throws_ok(
  $$ insert into public.categories (id, user_id, name, kind) values ('11000000-0000-4000-8000-0000000000e3', '11000000-0000-4000-8000-000000000001', 'dining', 'expense') $$,
  '23505',
  null,
  'a case-different duplicate "dining" is rejected by the expression index'
);
rollback to savepoint s21;

-- deliberately absent constraints: no global amount_cents <> 0 rule for
-- ordinary rows, no "must have a category" rule.
savepoint s22;
select lives_ok(
  $$ insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents) values ('11000000-0000-4000-8000-000000010008', '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-0000000000a1', '2026-01-01', 'x', 'expense', 0) $$,
  'a zero-amount, uncategorized ordinary expense is legal (matches the txn-094 fixture shape)'
);
rollback to savepoint s22;

-- No finish() -- this file uses SAVEPOINT/ROLLBACK TO SAVEPOINT
-- extensively, which rolls back pgtap's own internal bookkeeping (see
-- 020-movements.sql for the full explanation).
rollback;
