-- Seed parity: the generated seed.sql reproduces the current
-- mock-backed application exactly.
begin;
select plan(31);

-- Row counts
select is((select count(*)::int from public.accounts), 7, '7 accounts seeded');
select is((select count(*)::int from public.categories), 12, '12 categories seeded');
select is((select count(*)::int from public.movements), 12, '12 movements seeded');
select is((select count(*)::int from public.transactions), 104, '104 transactions seeded');
select is((select count(*)::int from public.budgets), 8, '8 budgets seeded');
select is((select count(*)::int from public.bills), 5, '5 bills seeded');
select is((select count(*)::int from public.goals), 4, '4 goals seeded');
select is((select count(*)::int from public.net_worth_snapshots), 6, '6 net worth snapshots seeded');

-- account_balances matches every fixture balanceCents exactly
select is((select balance_cents from public.account_balances where name = 'Everyday Checking'), 423155::bigint, 'checking balance matches fixture');
select is((select balance_cents from public.account_balances where name = 'High-Yield Savings'), 8500000::bigint, 'savings balance matches fixture');
select is((select balance_cents from public.account_balances where name = 'Cash Wallet'), 0::bigint, 'cash balance matches fixture');
select is((select balance_cents from public.account_balances where name = 'Rewards Credit Card'), -128450::bigint, 'credit balance matches fixture');
select is((select balance_cents from public.account_balances where name = 'Brokerage Account'), 3245075::bigint, 'investment balance matches fixture');
select is((select balance_cents from public.account_balances where name = 'Auto Loan'), -1432000::bigint, 'loan balance matches fixture');
select is((select balance_cents from public.account_balances where name = 'Old Checking (Closed)'), 1234::bigint, 'archived checking balance matches fixture');

-- goal_balances matches every fixture savedCents exactly
select is((select saved_cents from public.goal_balances where name = 'Emergency Fund'), 975000::bigint, 'emergency fund saved matches fixture');
select is((select saved_cents from public.goal_balances where name = 'Europe Trip'), 500000::bigint, 'europe trip saved matches fixture (exactly complete)');
select is((select saved_cents from public.goal_balances where name = 'New Car Down Payment'), 210000::bigint, 'car down payment saved matches fixture');
select is((select saved_cents from public.goal_balances where name = 'Home Renovation'), 345000::bigint, 'home renovation saved matches fixture (over-funded)');

-- net_worth_snapshots match lib/mock/net-worth.ts verbatim
select is((select net_worth_cents from public.net_worth_snapshots where month = '2026-03'), 9850000::bigint, '2026-03 net worth matches fixture verbatim');
select is((select net_worth_cents from public.net_worth_snapshots where month = '2026-08'), 10607780::bigint, '2026-08 net worth matches fixture verbatim');

-- The latest snapshot equals current account totals under the same
-- convention the fixture coherence test in lib/mock/index.test.ts checks.
select is(
  (select assets_cents from public.net_worth_snapshots where month = '2026-08'),
  (select coalesce(sum(balance_cents), 0)::bigint from public.account_balances where type not in ('credit', 'loan') and is_archived = false),
  '2026-08 assets_cents equals current non-archived asset account totals'
);
select is(
  (select liabilities_cents from public.net_worth_snapshots where month = '2026-08'),
  (select coalesce(-sum(balance_cents), 0)::bigint from public.account_balances where type in ('credit', 'loan') and is_archived = false),
  '2026-08 liabilities_cents equals current non-archived liability account totals'
);

-- Each bill's earliest scheduled occurrence equals its fixture dueDate
select is((select min(due_date) from public.bill_occurrences o join public.bills b on b.id = o.bill_id where b.name = 'Electric Bill' and o.status = 'scheduled'), '2026-08-18'::date, 'electric bill next-unpaid matches fixture dueDate');
select is((select min(due_date) from public.bill_occurrences o join public.bills b on b.id = o.bill_id where b.name = 'Streaming Subscription' and o.status = 'scheduled'), '2026-08-22'::date, 'streaming bill next-unpaid matches fixture dueDate');
select is((select min(due_date) from public.bill_occurrences o join public.bills b on b.id = o.bill_id where b.name = 'Internet Bill' and o.status = 'scheduled'), '2026-08-23'::date, 'internet bill next-unpaid matches fixture dueDate');
select is((select min(due_date) from public.bill_occurrences o join public.bills b on b.id = o.bill_id where b.name = 'Gym Membership' and o.status = 'scheduled'), '2026-09-01'::date, 'gym bill next-unpaid matches fixture dueDate');
select is((select min(due_date) from public.bill_occurrences o join public.bills b on b.id = o.bill_id where b.name = 'Car Insurance' and o.status = 'scheduled'), '2026-09-05'::date, 'insurance bill next-unpaid matches fixture dueDate');

-- Historical occurrence amount is the bill's amount captured at
-- generation time, independent of any later transaction amount.
select is(
  (select o.amount_cents from public.bill_occurrences o join public.bills b on b.id = o.bill_id where b.name = 'Electric Bill' and o.due_date = '2026-03-18'),
  14500::bigint,
  'a paid electric occurrence keeps the bill amount, not the linked transaction amount'
);

-- The one legal manually-recorded payment (no linked transaction)
select is(
  (select transaction_id from public.bill_occurrences o join public.bills b on b.id = o.bill_id where b.name = 'Car Insurance' and o.due_date = '2025-09-05'),
  null::uuid,
  'the 2025 insurance occurrence is a legal paid row with no linked transaction'
);

-- Exactly one profile (the seed placeholder user)
select is((select count(*)::int from public.profiles), 1, 'exactly one seeded profile');

select * from finish();
rollback;
