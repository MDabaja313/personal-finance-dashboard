-- Net-worth snapshot writer: as-of month-end boundary precision,
-- asset/liability classification across account types, archived-account
-- exclusion, and idempotency (single-month and range). Uses dedicated
-- test data, not the seeded fixture's March-July history, so exact
-- expected totals can be hand-computed and asserted verbatim.
--
-- Both functions are SECURITY DEFINER, owned by finance_snapshot_writer,
-- with EXECUTE revoked from PUBLIC/anon/authenticated -- called here as
-- the migration owner (postgres), which is a member of
-- finance_snapshot_writer (see migration 7) and so is not blocked by the
-- REVOKE'd EXECUTE grants.
begin;
select plan(13);

insert into auth.users (id, aud, role, email) values
  ('16000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'snap-test@local.test');
insert into public.profiles (id) values ('16000000-0000-4000-8000-000000000001');

-- Four live accounts spanning both asset types (checking, savings) and
-- both liability types (credit, loan), plus one archived account whose
-- large opening balance would visibly change every total below if it
-- were wrongly included.
insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('16000000-0000-4000-8000-0000000000a1', '16000000-0000-4000-8000-000000000001', 'Checking', 'Bank', 'checking', 100000),
  ('16000000-0000-4000-8000-0000000000a2', '16000000-0000-4000-8000-000000000001', 'Savings', 'Bank', 'savings', 5000),
  ('16000000-0000-4000-8000-0000000000a3', '16000000-0000-4000-8000-000000000001', 'Credit Card', 'Bank', 'credit', -20000),
  ('16000000-0000-4000-8000-0000000000a4', '16000000-0000-4000-8000-000000000001', 'Loan', 'Bank', 'loan', -50000),
  ('16000000-0000-4000-8000-0000000000a5', '16000000-0000-4000-8000-000000000001', 'Archived Checking', 'Bank', 'checking', 99999999);
update public.accounts set is_archived = true where id = '16000000-0000-4000-8000-0000000000a5';

-- Transactions straddling the January/February boundary on every live
-- account. The 01-31 rows land exactly on the target month-end
-- (included); the 02-* rows land the day after (excluded from the
-- January snapshot, included in February's).
insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents) values
  ('16000000-0000-4000-8000-000000000101', '16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-0000000000a1', '2026-01-10', 'x', 'expense', -1000),
  ('16000000-0000-4000-8000-000000000102', '16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-0000000000a1', '2026-01-31', 'x', 'expense', -500),
  ('16000000-0000-4000-8000-000000000103', '16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-0000000000a1', '2026-02-15', 'x', 'income', 2000),
  ('16000000-0000-4000-8000-000000000104', '16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-0000000000a2', '2026-01-20', 'x', 'income', 200),
  ('16000000-0000-4000-8000-000000000105', '16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-0000000000a3', '2026-01-05', 'x', 'expense', -300),
  ('16000000-0000-4000-8000-000000000106', '16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-0000000000a3', '2026-02-10', 'x', 'expense', -100),
  ('16000000-0000-4000-8000-000000000107', '16000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-0000000000a4', '2026-01-25', 'x', 'income', 200);

-- All Jan+Feb transactions above already exist BEFORE either snapshot
-- is written -- i.e. "today" (the latest data present) is already past
-- both target months. This is what proves backfill uses the as-of
-- month-end query, never a live/current balance: if it read
-- account_balances instead, the January snapshot below would wrongly
-- include the February rows too.
select private.write_net_worth_snapshot('16000000-0000-4000-8000-000000000001'::uuid, '2026-01');
select private.write_net_worth_snapshot('16000000-0000-4000-8000-000000000001'::uuid, '2026-02');

-- ============================================================
-- As-of target month end + historical backfill isolation (January)
-- checking: 100000 - 1000 - 500 = 98500 (the 02-15 income is excluded)
-- savings:  5000 + 200 = 5200
-- assets:   103700
-- credit:   -20000 - 300 = -20300 (the 02-10 expense is excluded) -> liability magnitude 20300
-- loan:     -50000 + 200 = -49800 -> liability magnitude 49800
-- liabilities: 70100
-- net worth: 33600
-- ============================================================

select is((select assets_cents from public.net_worth_snapshots where user_id = '16000000-0000-4000-8000-000000000001' and month = '2026-01'), 103700::bigint, 'January assets_cents is as-of month-end, excluding the February transactions already present in the table');
select is((select liabilities_cents from public.net_worth_snapshots where user_id = '16000000-0000-4000-8000-000000000001' and month = '2026-01'), 70100::bigint, 'January liabilities_cents is as-of month-end, excluding the February transactions already present in the table');
select is((select net_worth_cents from public.net_worth_snapshots where user_id = '16000000-0000-4000-8000-000000000001' and month = '2026-01'), 33600::bigint, 'January net_worth_cents equals assets minus liabilities');

-- ============================================================
-- As-of target month end (February) -- the boundary moves forward and
-- now includes the previously-excluded rows.
-- checking: 100000 - 1000 - 500 + 2000 = 100500
-- savings:  5200 (unchanged, no February row)
-- assets:   105700
-- credit:   -20300 - 100 = -20400 -> liability magnitude 20400
-- loan:     -49800 (unchanged, no February row) -> liability magnitude 49800
-- liabilities: 70200
-- net worth: 35500
-- ============================================================

select is((select assets_cents from public.net_worth_snapshots where user_id = '16000000-0000-4000-8000-000000000001' and month = '2026-02'), 105700::bigint, 'February assets_cents includes both months'' transactions up through its own month-end');
select is((select liabilities_cents from public.net_worth_snapshots where user_id = '16000000-0000-4000-8000-000000000001' and month = '2026-02'), 70200::bigint, 'February liabilities_cents includes both months'' transactions up through its own month-end');
select is((select net_worth_cents from public.net_worth_snapshots where user_id = '16000000-0000-4000-8000-000000000001' and month = '2026-02'), 35500::bigint, 'February net_worth_cents equals assets minus liabilities');

-- ============================================================
-- Classification: credit/loan are liabilities reported as a POSITIVE
-- magnitude despite a negative signed balance; every other type
-- (checking, savings) is an asset. Already implied by the January
-- totals above (103700/70100 only reconciles under this classification)
-- but asserted directly here against the two liability accounts.
-- ============================================================

select is(
  (select assets_cents from public.net_worth_snapshots where user_id = '16000000-0000-4000-8000-000000000001' and month = '2026-01')
    - (select 98500 + 5200),
  0::bigint,
  'checking and savings both contribute their positive balance to assets_cents'
);
select is(
  (select liabilities_cents from public.net_worth_snapshots where user_id = '16000000-0000-4000-8000-000000000001' and month = '2026-01')
    - (select 20300 + 49800),
  0::bigint,
  'credit and loan both contribute the NEGATED signed balance (a positive magnitude) to liabilities_cents'
);

-- ============================================================
-- Archived accounts excluded: the archived account's 99999999-cent
-- opening balance would swamp every total above if it were wrongly
-- included -- it is not, since assets_cents for January is exactly
-- 103700, not 100003700-plus.
-- ============================================================

select is(
  (select assets_cents from public.net_worth_snapshots where user_id = '16000000-0000-4000-8000-000000000001' and month = '2026-01'),
  103700::bigint,
  'the archived account''s huge balance is excluded from assets_cents entirely'
);

-- ============================================================
-- Single-month idempotency: writing the same month twice updates the
-- existing row (ON CONFLICT ... DO UPDATE) rather than duplicating it,
-- and produces the identical figures both times.
-- ============================================================

select private.write_net_worth_snapshot('16000000-0000-4000-8000-000000000001'::uuid, '2026-01');
select is(
  (select count(*)::int from public.net_worth_snapshots where user_id = '16000000-0000-4000-8000-000000000001' and month = '2026-01'),
  1,
  'writing the same month twice leaves exactly one row, not a duplicate'
);
select is(
  (select assets_cents from public.net_worth_snapshots where user_id = '16000000-0000-4000-8000-000000000001' and month = '2026-01'),
  103700::bigint,
  're-writing the same month reproduces the identical assets_cents'
);

-- ============================================================
-- Range idempotency: writing the same range twice leaves exactly one
-- row per month, with unchanged figures.
-- ============================================================

select private.write_net_worth_snapshots_for_range('16000000-0000-4000-8000-000000000001'::uuid, '2026-01', '2026-02');
select private.write_net_worth_snapshots_for_range('16000000-0000-4000-8000-000000000001'::uuid, '2026-01', '2026-02');
select is(
  (select count(*)::int from public.net_worth_snapshots where user_id = '16000000-0000-4000-8000-000000000001'),
  2,
  'writing the same [2026-01, 2026-02] range twice leaves exactly one row per month'
);
select is(
  (select net_worth_cents from public.net_worth_snapshots where user_id = '16000000-0000-4000-8000-000000000001' and month = '2026-02'),
  35500::bigint,
  'range re-write reproduces February''s identical net_worth_cents'
);

select * from finish();
rollback;
