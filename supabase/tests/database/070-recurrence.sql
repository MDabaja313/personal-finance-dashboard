-- Bill recurrence: the pure date-arithmetic function
-- (private.next_bill_occurrence_date) for every frequency, plus the
-- SECURITY DEFINER generator (private.generate_bill_occurrences) for
-- idempotency, amount-copy-at-generation-time, and paid/skipped
-- row-preservation behavior. Both functions live in `private` and have
-- EXECUTE revoked from PUBLIC/anon/authenticated -- called here as the
-- migration owner (postgres), a superuser, which bypasses privilege
-- checks entirely, same as every other privileged setup step in this
-- suite.
begin;
select plan(25);

insert into auth.users (id, aud, role, email) values
  ('15000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'rec-test@local.test');
insert into public.profiles (id) values ('15000000-0000-4000-8000-000000000001');

-- ============================================================
-- Pure function: weekly
-- ============================================================

select is(
  private.next_bill_occurrence_date('2026-01-05'::date, 'weekly'::public.bill_frequency, '2026-01-05'::date),
  '2026-01-12'::date,
  'weekly: first occurrence after the anchor is anchor + 7 days'
);
select is(
  private.next_bill_occurrence_date('2026-01-05'::date, 'weekly'::public.bill_frequency, '2026-01-12'::date),
  '2026-01-19'::date,
  'weekly: subsequent occurrence is another 7 days later'
);

-- ============================================================
-- Pure function: biweekly
-- ============================================================

select is(
  private.next_bill_occurrence_date('2026-01-05'::date, 'biweekly'::public.bill_frequency, '2026-01-05'::date),
  '2026-01-19'::date,
  'biweekly: first occurrence after the anchor is anchor + 14 days'
);
select is(
  private.next_bill_occurrence_date('2026-01-05'::date, 'biweekly'::public.bill_frequency, '2026-01-19'::date),
  '2026-02-02'::date,
  'biweekly: subsequent occurrence is another 14 days later'
);

-- ============================================================
-- Pure function: Jan-31 monthly, no-drift sequence. Every step clamps
-- the ORIGINAL anchor day-of-month against each candidate month
-- independently -- Feb 28 -> Mar 31 -> Apr 30 -> May 31, never Mar 28.
-- ============================================================

select is(
  private.next_bill_occurrence_date('2026-01-31'::date, 'monthly'::public.bill_frequency, '2026-01-31'::date),
  '2026-02-28'::date,
  'Jan-31 monthly: February clamps to the 28th (2026 is not a leap year)'
);
select is(
  private.next_bill_occurrence_date('2026-01-31'::date, 'monthly'::public.bill_frequency, '2026-02-28'::date),
  '2026-03-31'::date,
  'Jan-31 monthly: March recovers to the 31st -- clamped from the ORIGINAL anchor, not from February''s 28th'
);
select is(
  private.next_bill_occurrence_date('2026-01-31'::date, 'monthly'::public.bill_frequency, '2026-03-31'::date),
  '2026-04-30'::date,
  'Jan-31 monthly: April clamps to the 30th'
);
select is(
  private.next_bill_occurrence_date('2026-01-31'::date, 'monthly'::public.bill_frequency, '2026-04-30'::date),
  '2026-05-31'::date,
  'Jan-31 monthly: May recovers to the 31st'
);

-- ============================================================
-- Pure function: Feb-29 yearly, clamp and leap-year recovery. 2024 is
-- a leap year (anchor); 2025-2027 are not (clamp to Feb 28 each time,
-- independently); 2028 is a leap year again (recovers to Feb 29).
-- ============================================================

select is(
  private.next_bill_occurrence_date('2024-02-29'::date, 'yearly'::public.bill_frequency, '2024-02-29'::date),
  '2025-02-28'::date,
  'Feb-29 yearly: 2025 (non-leap) clamps to Feb 28'
);
select is(
  private.next_bill_occurrence_date('2024-02-29'::date, 'yearly'::public.bill_frequency, '2025-02-28'::date),
  '2026-02-28'::date,
  'Feb-29 yearly: 2026 (non-leap) clamps to Feb 28'
);
select is(
  private.next_bill_occurrence_date('2024-02-29'::date, 'yearly'::public.bill_frequency, '2026-02-28'::date),
  '2027-02-28'::date,
  'Feb-29 yearly: 2027 (non-leap) clamps to Feb 28'
);
select is(
  private.next_bill_occurrence_date('2024-02-29'::date, 'yearly'::public.bill_frequency, '2027-02-28'::date),
  '2028-02-29'::date,
  'Feb-29 yearly: 2028 (leap) recovers to Feb 29'
);

-- ============================================================
-- generate_bill_occurrences: idempotency, amount-copy-at-generation,
-- and paid/skipped row preservation.
-- ============================================================

insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date) values
  ('15000000-0000-4000-8000-0000000000b1', '15000000-0000-4000-8000-000000000001', 'Monthly Bill', 100, 'monthly', '2026-01-01');

-- First generation: anchor itself, then monthly through the horizon --
-- 2026-01-01, 02-01, 03-01, 04-01 (four occurrences, horizon inclusive).
select is(
  private.generate_bill_occurrences('15000000-0000-4000-8000-000000000001'::uuid, '2026-04-01'::date),
  4,
  'first generation inserts exactly the four occurrences through the horizon'
);
select is(
  (select count(*)::int from public.bill_occurrences where bill_id = '15000000-0000-4000-8000-0000000000b1'),
  4,
  'four occurrence rows exist after first generation'
);
select is(
  (select amount_cents from public.bill_occurrences where bill_id = '15000000-0000-4000-8000-0000000000b1' and due_date = '2026-01-01'),
  100::bigint,
  'each generated occurrence copies the bill''s amount_cents at generation time'
);

-- Idempotency: calling again with the SAME horizon inserts zero new
-- rows (ON CONFLICT (bill_id, due_date) DO NOTHING) and leaves the
-- count unchanged.
select is(
  private.generate_bill_occurrences('15000000-0000-4000-8000-000000000001'::uuid, '2026-04-01'::date),
  0,
  'regenerating over the same horizon inserts zero new rows'
);
select is(
  (select count(*)::int from public.bill_occurrences where bill_id = '15000000-0000-4000-8000-0000000000b1'),
  4,
  'the occurrence count is unchanged after the idempotent regeneration'
);

-- Mark the 2026-02-01 occurrence paid, then edit the bill's amount --
-- a later generation must neither rewrite the paid row's amount/status
-- nor retroactively change ANY existing occurrence's amount, only new
-- ones going forward.
update public.bill_occurrences
  set status = 'paid', paid_on = '2026-02-03'
  where bill_id = '15000000-0000-4000-8000-0000000000b1' and due_date = '2026-02-01';
update public.bills set amount_cents = 999 where id = '15000000-0000-4000-8000-0000000000b1';

select is(
  private.generate_bill_occurrences('15000000-0000-4000-8000-000000000001'::uuid, '2026-06-01'::date),
  2,
  'extending the horizon after an amount change inserts only the two new occurrences (05-01, 06-01)'
);
select is(
  (select status from public.bill_occurrences where bill_id = '15000000-0000-4000-8000-0000000000b1' and due_date = '2026-02-01'),
  'paid',
  'the paid occurrence''s status is untouched by the later generation call'
);
select is(
  (select paid_on from public.bill_occurrences where bill_id = '15000000-0000-4000-8000-0000000000b1' and due_date = '2026-02-01'),
  '2026-02-03'::date,
  'the paid occurrence''s paid_on is untouched by the later generation call'
);
select is(
  (select amount_cents from public.bill_occurrences where bill_id = '15000000-0000-4000-8000-0000000000b1' and due_date = '2026-02-01'),
  100::bigint,
  'the paid occurrence keeps its ORIGINAL amount_cents, not the bill''s new amount -- history is a fixed fact'
);
select is(
  (select amount_cents from public.bill_occurrences where bill_id = '15000000-0000-4000-8000-0000000000b1' and due_date = '2026-01-01'),
  100::bigint,
  'an untouched scheduled occurrence ALSO keeps its original amount_cents -- editing the bill never rewrites existing rows'
);
select is(
  (select amount_cents from public.bill_occurrences where bill_id = '15000000-0000-4000-8000-0000000000b1' and due_date = '2026-05-01'),
  999::bigint,
  'a newly generated occurrence after the amount change copies the NEW amount_cents'
);

-- A skipped row is likewise preserved verbatim by a later generation.
update public.bill_occurrences
  set status = 'skipped'
  where bill_id = '15000000-0000-4000-8000-0000000000b1' and due_date = '2026-03-01';
select is(
  private.generate_bill_occurrences('15000000-0000-4000-8000-000000000001'::uuid, '2026-06-01'::date),
  0,
  'regenerating again over an unchanged horizon inserts zero new rows'
);
select is(
  (select status from public.bill_occurrences where bill_id = '15000000-0000-4000-8000-0000000000b1' and due_date = '2026-03-01'),
  'skipped',
  'the skipped occurrence''s status is untouched by any later generation call'
);

select * from finish();
rollback;
