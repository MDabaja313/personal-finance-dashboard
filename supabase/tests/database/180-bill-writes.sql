-- Phase 7 CP7 behavior: bill writes, the occurrence state machine, the
-- recurrence bridge's privilege boundary, and the history guarantees that
-- make an edit safe.
--
-- 100-write-grants.sql owns the *grant matrix* for these two relations
-- (which columns, which verbs, and that `anon` reaches none of it). This
-- file owns everything the matrix cannot express:
--
--   * assert_bill_refs() -- active (any-kind) category, active account, and
--     the "only when the column actually changes" rule on UPDATE.
--   * guard_bill_occurrence_transition() -- the four supported
--     transitions, the two refused ones, idempotent no-ops, the owner-
--     timezone paid_on ceiling (including a timezone-boundary proof), and
--     the immutability of everything that is not part of the state
--     machine.
--   * create_bill / replace_bill / set_bill_archived -- atomicity, the
--     terms-changed rebuild rule, and cross-owner refusal.
--   * maintain_bill_schedule -- the recurrence arithmetic end to end
--     (weekly, biweekly, Jan-31 monthly, leap-year yearly), the rolling
--     horizon, idempotence on re-run, and the fact that no caller can
--     choose an owner or a horizon.
--   * The history guarantees: a paid or skipped occurrence is never
--     rewritten, never deleted, and never regenerated away, by any path.
--
-- Role/claim switches use the verified local auth.uid() form, exactly as
-- 060/100/110/140/150/170 do:
--   SET LOCAL ROLE authenticated;
--   SET LOCAL request.jwt.claim.sub = '<uuid>';
-- Fixture setup runs as the migration owner (postgres has BYPASSRLS).
begin;
select plan(87);

-- ============================================================
-- Fixture: two owners, so every cross-owner claim is testable
-- ============================================================

insert into auth.users (id, aud, role, email) values
  ('19000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'bill-a@local.test'),
  ('19000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'bill-b@local.test');

-- Owner A sits in UTC; owner B sits in Pacific/Kiritimati (UTC+14), which
-- is the timezone-boundary proof below: B's calendar day is *ahead* of
-- UTC's for ten hours of every day, so a paid_on that is "tomorrow" in
-- UTC can be legitimately "today" for B.
insert into public.profiles (id, timezone) values
  ('19000000-0000-4000-8000-000000000001', 'UTC'),
  ('19000000-0000-4000-8000-000000000002', 'Pacific/Kiritimati');

insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('19000000-0000-4000-8000-0000000000a1', '19000000-0000-4000-8000-000000000001', 'A-checking', 'Bank', 'checking', 100000),
  ('19000000-0000-4000-8000-0000000000a2', '19000000-0000-4000-8000-000000000001', 'A-archived', 'Bank', 'checking', 0),
  ('19000000-0000-4000-8000-0000000000a3', '19000000-0000-4000-8000-000000000002', 'B-checking', 'Bank', 'checking', 100000);

update public.accounts set is_archived = true where id = '19000000-0000-4000-8000-0000000000a2';

insert into public.categories (id, user_id, name, kind) values
  ('19000000-0000-4000-8000-0000000000c1', '19000000-0000-4000-8000-000000000001', 'A-utilities', 'expense'),
  ('19000000-0000-4000-8000-0000000000c2', '19000000-0000-4000-8000-000000000001', 'A-salary', 'income'),
  ('19000000-0000-4000-8000-0000000000c3', '19000000-0000-4000-8000-000000000001', 'A-retired', 'expense'),
  ('19000000-0000-4000-8000-0000000000c4', '19000000-0000-4000-8000-000000000002', 'B-utilities', 'expense');

update public.categories set is_archived = true where id = '19000000-0000-4000-8000-0000000000c3';

-- One transaction per owner, for the payment-link assertions.
insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents) values
  ('19000000-0000-4000-8000-000000000101', '19000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-0000000000a1', '2026-01-05', 'A-payment', 'expense', -14500),
  ('19000000-0000-4000-8000-000000000102', '19000000-0000-4000-8000-000000000002', '19000000-0000-4000-8000-0000000000a3', '2026-01-05', 'B-payment', 'expense', -14500);

-- Owner B's bill, for cross-owner refusal. Created directly rather than
-- through the RPC, so it exists before any role switch.
insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date) values
  ('19000000-0000-4000-8000-000000000201', '19000000-0000-4000-8000-000000000002', 'B-bill', 200, 'monthly', '2026-01-01');
insert into public.bill_occurrences (id, user_id, bill_id, due_date, status, amount_cents) values
  ('19000000-0000-4000-8000-000000000301', '19000000-0000-4000-8000-000000000002', '19000000-0000-4000-8000-000000000201', '2026-01-01', 'scheduled', 200);

-- ============================================================
-- Owner A, as authenticated
-- ============================================================

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '19000000-0000-4000-8000-000000000001';

select is(
  (select auth.uid()),
  '19000000-0000-4000-8000-000000000001'::uuid,
  'auth.uid() reflects the request.jwt.claim.sub GUC for owner A'
);

-- ------------------------------------------------------------
-- create_bill: the bill and its schedule, in one transaction
-- ------------------------------------------------------------

select lives_ok(
  $$ select public.create_bill(
       '19000000-0000-4000-8000-000000000401', 'Rent', 120000, 'monthly',
       '2026-01-31', '19000000-0000-4000-8000-0000000000c1',
       '19000000-0000-4000-8000-0000000000a1') $$,
  'create_bill writes an owned bill with an active category and an active account'
);
select is(
  (select count(*)::int from public.bills where id = '19000000-0000-4000-8000-000000000401'),
  1,
  'the bill row exists'
);
select is(
  (select user_id from public.bills where id = '19000000-0000-4000-8000-000000000401'),
  '19000000-0000-4000-8000-000000000001'::uuid,
  'the bill is owned by the caller -- the RPC takes no owner parameter'
);
select is(
  (select is_archived from public.bills where id = '19000000-0000-4000-8000-000000000401'),
  false,
  'a bill is never created already archived'
);

-- Jan-31 monthly: the no-drift sequence, generated end to end rather than
-- asserted on the pure function (070-recurrence.sql owns that half).
-- Feb clamps to the 28th and March recovers to the 31st -- every value
-- clamped independently from the ORIGINAL anchor, never from the prior
-- occurrence.
select is(
  (select array_agg(due_date order by due_date)
   from (select due_date from public.bill_occurrences
         where bill_id = '19000000-0000-4000-8000-000000000401'
         order by due_date limit 4) first_four),
  array['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']::date[],
  'Jan-31 monthly generates Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 with no drift'
);
select is(
  (select count(distinct due_date)::int from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000401'),
  (select count(*)::int from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000401'),
  'no duplicate due dates -- UNIQUE (bill_id, due_date) plus ON CONFLICT DO NOTHING'
);
select is(
  (select count(*)::int from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000401' and status <> 'scheduled'),
  0,
  'every generated occurrence starts scheduled'
);
select is(
  (select count(distinct amount_cents)::int from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000401'),
  1,
  'every generated occurrence copied the bill amount at generation time'
);

-- The rolling horizon: one year from the owner's own today, and nothing
-- beyond it. Asserted against the owner's timezone-derived day rather
-- than against a literal, so the assertion does not age.
select ok(
  (select max(due_date) from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000401')
  <= ((now() at time zone 'UTC')::date + interval '1 year')::date,
  'no occurrence is generated beyond the one-year rolling horizon'
);
select ok(
  (select max(due_date) from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000401')
  > (now() at time zone 'UTC')::date,
  'the horizon reaches past the owner''s today -- there is always a next scheduled occurrence'
);

-- Re-running the scheduler writes nothing new: generation is idempotent.
select is(
  public.maintain_bill_schedule('19000000-0000-4000-8000-000000000401', false),
  0,
  'a second maintenance pass generates zero rows -- generation is idempotent'
);

-- ------------------------------------------------------------
-- create_bill: the reference rules assert_bill_refs() enforces
-- ------------------------------------------------------------

-- An income category is ACCEPTED, and that is the assertion. No approved
-- pre-CP7 requirement makes a bill's category an expense category:
-- `bills.category_id` is a plain nullable composite FK with no CHECK, and
-- neither database-schema.md nor rls-policies.md states a kind rule for it.
-- CP6's budgets rule is not transferable (there, "expense" is what the row
-- means), and guard_category_kind_change() naming `bills` proves only that a
-- referenced category's kind becomes immutable. Asserted positively so a later
-- checkpoint cannot quietly introduce the narrower rule.
select lives_ok(
  $$ select public.create_bill('19000000-0000-4000-8000-000000000402', 'x', 100, 'monthly',
       '2026-01-01', '19000000-0000-4000-8000-0000000000c2', null) $$,
  'a bill MAY name an income category -- kind is deliberately unconstrained'
);
select is(
  (select category_id from public.bills where id = '19000000-0000-4000-8000-000000000402'),
  '19000000-0000-4000-8000-0000000000c2'::uuid,
  'and the income category is actually stored'
);
select throws_ok(
  $$ select public.create_bill('19000000-0000-4000-8000-000000000403', 'x', 100, 'monthly',
       '2026-01-01', '19000000-0000-4000-8000-0000000000c3', null) $$,
  '23514', null,
  'a bill cannot name an archived category'
);
select throws_ok(
  $$ select public.create_bill('19000000-0000-4000-8000-000000000404', 'x', 100, 'monthly',
       '2026-01-01', null, '19000000-0000-4000-8000-0000000000a2') $$,
  '23514', null,
  'a bill cannot name an archived account'
);
-- A foreign category or account with A's own user_id: the composite FKs
-- (category_id, user_id) -> categories(id, user_id) and
-- (account_id, user_id) -> accounts(id, user_id) have no row to match,
-- since B's rows carry B's user_id. Structurally impossible, not merely
-- policy-refused. Both FKs are DEFERRABLE INITIALLY DEFERRED, so the
-- violation surfaces only once constraints are checked -- `set
-- constraints all immediate` inside the same savepoint, exactly as
-- 040-ownership.sql and 170-budget-goal-writes.sql do.
savepoint bill_foreign_category;
select public.create_bill('19000000-0000-4000-8000-000000000405', 'x', 100, 'monthly',
  '2026-01-01', '19000000-0000-4000-8000-0000000000c4', null);
select throws_ok(
  $$ set constraints all immediate $$, '23503', null,
  'a bill cannot name another owner''s category -- the composite FK owns that case'
);
rollback to savepoint bill_foreign_category;
set constraints all deferred;

savepoint bill_foreign_account;
select public.create_bill('19000000-0000-4000-8000-000000000406', 'x', 100, 'monthly',
  '2026-01-01', null, '19000000-0000-4000-8000-0000000000a3');
select throws_ok(
  $$ set constraints all immediate $$, '23503', null,
  'a bill cannot name another owner''s account'
);
rollback to savepoint bill_foreign_account;
set constraints all deferred;
select lives_ok(
  $$ select public.create_bill('19000000-0000-4000-8000-000000000407', 'No refs', 100, 'yearly',
       '2024-02-29', null, null) $$,
  'category and account are both genuinely optional'
);

-- Leap-year yearly, generated: a Feb-29 anchor clamps to Feb 28 in a
-- non-leap year. (The return to Feb 29 in the next leap year is
-- 070-recurrence.sql's, on the pure function, since it lies beyond a
-- one-year horizon.)
select is(
  (select array_agg(due_date order by due_date)
   from public.bill_occurrences where bill_id = '19000000-0000-4000-8000-000000000407'),
  (select array_agg(d order by d) from (
     select generate_series::date as d
     from generate_series(
       '2024-02-29'::date, ((now() at time zone 'UTC')::date + interval '1 year')::date, '1 year'::interval
     )
     where generate_series::date >= '2024-02-29'::date
   ) expected
   where d in (select due_date from public.bill_occurrences where bill_id = '19000000-0000-4000-8000-000000000407')),
  'a Feb-29 yearly bill generates one occurrence per year from its anchor'
);
select ok(
  exists (select 1 from public.bill_occurrences
          where bill_id = '19000000-0000-4000-8000-000000000407' and due_date = '2024-02-29'),
  'the Feb-29 anchor occurrence itself exists -- generation starts at the anchor for a new bill'
);
select ok(
  exists (select 1 from public.bill_occurrences
          where bill_id = '19000000-0000-4000-8000-000000000407' and due_date = '2025-02-28'),
  'the following non-leap year clamps to Feb 28'
);

-- Weekly and biweekly, generated end to end.
select lives_ok(
  $$ select public.create_bill('19000000-0000-4000-8000-000000000408', 'Weekly', 500, 'weekly',
       '2026-01-05', null, null) $$,
  'a weekly bill is created'
);
select is(
  (select array_agg(due_date order by due_date)
   from (select due_date from public.bill_occurrences
         where bill_id = '19000000-0000-4000-8000-000000000408'
         order by due_date limit 3) first_three),
  array['2026-01-05', '2026-01-12', '2026-01-19']::date[],
  'weekly steps 7 days from the anchor'
);
select lives_ok(
  $$ select public.create_bill('19000000-0000-4000-8000-000000000409', 'Biweekly', 500, 'biweekly',
       '2026-01-05', null, null) $$,
  'a biweekly bill is created'
);
select is(
  (select array_agg(due_date order by due_date)
   from (select due_date from public.bill_occurrences
         where bill_id = '19000000-0000-4000-8000-000000000409'
         order by due_date limit 3) first_three),
  array['2026-01-05', '2026-01-19', '2026-02-02']::date[],
  'biweekly steps 14 days from the anchor'
);

-- A first due date beyond the ordinary horizon still produces its anchor
-- occurrence -- otherwise the bill would be invisible on /bills, which is
-- indistinguishable from the create having failed.
select lives_ok(
  $$ select public.create_bill('19000000-0000-4000-8000-00000000040a', 'Far future', 100, 'yearly',
       ((now() at time zone 'UTC')::date + interval '3 years')::date, null, null) $$,
  'a bill anchored beyond the one-year horizon is created'
);
select is(
  (select count(*)::int from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-00000000040a'),
  1,
  'it gets exactly its anchor occurrence -- the horizon widens to the anchor and no further'
);

-- ------------------------------------------------------------
-- Atomicity: a SCHEDULER failure rolls the parent write back
-- ------------------------------------------------------------
-- The rollback assertions further down are triggered by assert_bill_refs(),
-- which fires on the parent INSERT/UPDATE itself. This pair is different and
-- is the one that actually proves the transaction boundary: the parent write
-- succeeds, and then generation fails inside public.maintain_bill_schedule.
-- Because the scheduler is called from *inside* the RPC body rather than as a
-- second PostgREST request, that failure aborts the whole function and the
-- bill row goes with it.
--
-- The failure is forced deterministically by the generator's iteration cap: a
-- weekly bill anchored in 1900 needs ~6,500 steps to reach the horizon, well
-- past the 5,000 guard.
select throws_ok(
  $$ select public.create_bill('19000000-0000-4000-8000-00000000040b', 'Pathological', 100,
       'weekly', '1900-01-01', null, null) $$,
  '23514', null,
  'create_bill fails when its schedule cannot be generated'
);
select is(
  (select count(*)::int from public.bills where id = '19000000-0000-4000-8000-00000000040b'),
  0,
  'and NO bill row survives -- generation is in the same transaction as the INSERT, not after it'
);

-- Idempotency key: the same id is a primary-key collision, not a second bill.
select throws_ok(
  $$ select public.create_bill('19000000-0000-4000-8000-000000000401', 'Rent', 120000, 'monthly',
       '2026-01-31', null, null) $$,
  '23505', null,
  'reusing a bill id collides on the primary key rather than creating a second bill'
);

-- ------------------------------------------------------------
-- The occurrence state machine
-- ------------------------------------------------------------

-- Work on the weekly bill's first occurrence, which is safely in the past
-- so paid_on can be any of several dates.
select is(
  (select status::text from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05'),
  'scheduled',
  'the occurrence under test starts scheduled'
);

select lives_ok(
  $$ update public.bill_occurrences set status = 'paid', paid_on = '2026-01-06', transaction_id = null
     where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
  'scheduled -> paid, recorded manually with no linked transaction'
);

-- Idempotent re-submission of the same resulting state.
select lives_ok(
  $$ update public.bill_occurrences set status = 'paid', paid_on = '2026-01-06', transaction_id = null
     where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
  'paid -> paid with the same values is idempotent, not an error'
);

-- paid -> skipped is refused. A correction goes back through scheduled.
select throws_ok(
  $$ update public.bill_occurrences set status = 'skipped', paid_on = null, transaction_id = null
     where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
  '23514', null,
  'paid -> skipped is not a supported transition'
);

-- paid -> scheduled clears both payment fields.
select lives_ok(
  $$ update public.bill_occurrences set status = 'scheduled', paid_on = null, transaction_id = null
     where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
  'paid -> scheduled (unmark) is supported'
);
select is(
  (select coalesce(paid_on::text, 'null') || '/' || coalesce(transaction_id::text, 'null')
   from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05'),
  'null/null',
  'unmarking clears paid_on and transaction_id'
);

-- A scheduled row may not retain payment fields -- the Phase 4 CHECK.
select throws_ok(
  $$ update public.bill_occurrences set status = 'scheduled', paid_on = '2026-01-06'
     where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
  '23514', null,
  'a scheduled occurrence cannot carry a paid_on'
);

-- scheduled -> skipped, and back.
select lives_ok(
  $$ update public.bill_occurrences set status = 'skipped', paid_on = null, transaction_id = null
     where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
  'scheduled -> skipped is supported'
);
select throws_ok(
  $$ update public.bill_occurrences set status = 'paid', paid_on = '2026-01-06'
     where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
  '23514', null,
  'skipped -> paid is not a supported transition'
);
select throws_ok(
  $$ update public.bill_occurrences set status = 'skipped', paid_on = null, transaction_id = '19000000-0000-4000-8000-000000000101'
     where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
  '23514', null,
  'a skipped occurrence cannot carry a transaction_id'
);
select lives_ok(
  $$ update public.bill_occurrences set status = 'scheduled', paid_on = null, transaction_id = null
     where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
  'skipped -> scheduled (unskip) is supported'
);

-- A paid occurrence requires paid_on -- the Phase 4 CHECK again.
select throws_ok(
  $$ update public.bill_occurrences set status = 'paid', paid_on = null
     where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
  '23514', null,
  'a paid occurrence must carry a paid_on'
);

-- ------------------------------------------------------------
-- The paid_on ceiling, in the owner's own timezone
-- ------------------------------------------------------------

select throws_ok(
  format(
    $$ update public.bill_occurrences set status = 'paid', paid_on = %L, transaction_id = null
       where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
    ((now() at time zone 'UTC')::date + 1)::text
  ),
  '23514', null,
  'paid_on may not be later than the owner''s own calendar day'
);
select lives_ok(
  format(
    $$ update public.bill_occurrences set status = 'paid', paid_on = %L, transaction_id = null
       where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
    (now() at time zone 'UTC')::date::text
  ),
  'paid_on may be exactly the owner''s own calendar day'
);

-- ------------------------------------------------------------
-- Linking an owned transaction
-- ------------------------------------------------------------

-- `transaction_origin` is written alongside the reference as of Phase 8 CP1:
-- `bill_occurrences_transaction_origin_ck` makes provenance and reference the
-- same fact, so a link with no origin is not a representable state. 'linked'
-- is the honest label here -- this transaction was written by hand, long
-- before the occurrence pointed at it -- and it is also the only label the
-- guard would accept, since 'generated' requires a transaction created by the
-- statement's own database transaction (200-bill-payment-ledger.sql).
select lives_ok(
  $$ update public.bill_occurrences
     set status = 'paid', paid_on = '2026-01-06',
         transaction_id = '19000000-0000-4000-8000-000000000101',
         transaction_origin = 'linked'
     where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
  'an owned transaction may be linked as the payment'
);
select is(
  (select amount_cents from public.transactions where id = '19000000-0000-4000-8000-000000000101'),
  -14500::bigint,
  'the linked transaction is not altered by the link -- its amount is unchanged'
);
-- `bill_occurrences_transaction_fk` is NO ACTION DEFERRABLE INITIALLY
-- DEFERRED (decision D10), so the refusal lands at COMMIT rather than at
-- the DELETE. Forced here with `set constraints all immediate`, the same
-- way every other composite-FK assertion in this suite is.
savepoint linked_transaction_delete;
delete from public.transactions where id = '19000000-0000-4000-8000-000000000101';
select throws_ok(
  $$ set constraints all immediate $$, '23503', null,
  'a linked transaction cannot be deleted while the occurrence still references it'
);
rollback to savepoint linked_transaction_delete;
set constraints all deferred;

select lives_ok(
  $$ update public.bill_occurrences
     set status = 'scheduled', paid_on = null, transaction_id = null, transaction_origin = null
     where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
  'unmarking clears the reference'
);
select lives_ok(
  $$ delete from public.transactions where id = '19000000-0000-4000-8000-000000000101' $$,
  'and the transaction then follows its ordinary deletion rules'
);

-- ------------------------------------------------------------
-- Nothing but the state machine may move
-- ------------------------------------------------------------
-- `authenticated` cannot even name these columns (100-write-grants.sql
-- proves the 42501), so the trigger is exercised as the owner of the
-- table instead -- which is the point: the rule holds for every role,
-- including the scheduler, not only for the one the grant constrains.

reset role;

select throws_ok(
  $$ update public.bill_occurrences set amount_cents = 999
     where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
  '23514', null,
  'an occurrence''s amount cannot be rewritten by ANY role -- it is a historical fact'
);
select throws_ok(
  $$ update public.bill_occurrences set due_date = '2030-01-01'
     where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
  '23514', null,
  'an occurrence''s due date cannot be rewritten by ANY role'
);
select throws_ok(
  $$ update public.bill_occurrences set bill_id = '19000000-0000-4000-8000-000000000401'
     where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
  '23514', null,
  'an occurrence cannot be re-parented onto another bill'
);

-- The Phase 4 deletion guard is still defense in depth behind the CP7
-- writer policy: a paid or skipped occurrence cannot be deleted even by a
-- role that holds an unrestricted DELETE.
update public.bill_occurrences set status = 'skipped', paid_on = null, transaction_id = null
  where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05';
select throws_ok(
  $$ delete from public.bill_occurrences
     where bill_id = '19000000-0000-4000-8000-000000000408' and due_date = '2026-01-05' $$,
  '23514', null,
  'guard_bill_occurrence_delete() still refuses to delete a skipped occurrence, for any role'
);

-- ============================================================
-- Edit: what a rebuild preserves, and what it replaces
-- ============================================================

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '19000000-0000-4000-8000-000000000001';

-- Mark one past occurrence paid and leave the skipped one from above, so
-- the rebuild has real history to preserve. The monthly Rent bill's
-- 2026-01-31 occurrence is in the past.
update public.bill_occurrences set status = 'paid', paid_on = '2026-02-01', transaction_id = null
  where bill_id = '19000000-0000-4000-8000-000000000401' and due_date = '2026-01-31';

create temporary table history_before on commit drop as
  select id, bill_id, due_date, status, amount_cents, transaction_id, paid_on, created_at
  from public.bill_occurrences
  where status <> 'scheduled';

-- An amount change rebuilds only scheduled occurrences due today or later.
select ok(
  (public.replace_bill('19000000-0000-4000-8000-000000000401', 'Rent', 150000, 'monthly',
     '2026-01-31', '19000000-0000-4000-8000-0000000000c1',
     '19000000-0000-4000-8000-0000000000a1') ->> 'rebuilt')::boolean,
  'an amount change reports a rebuild'
);
select is(
  (select count(*)::int from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000401'
     and status = 'scheduled'
     and due_date >= (now() at time zone 'UTC')::date
     and amount_cents <> 150000),
  0,
  'every future scheduled occurrence now carries the new amount'
);
select is(
  (select amount_cents from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000401' and due_date = '2026-01-31'),
  120000::bigint,
  'the paid historical occurrence keeps its ORIGINAL amount'
);
select is(
  (select count(*)::int from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000401'
     and status = 'scheduled'
     and due_date < (now() at time zone 'UTC')::date
     and amount_cents <> 120000),
  0,
  'already-overdue scheduled occurrences keep their original concrete amount too'
);

-- Nothing paid or skipped moved, byte for byte, anywhere in the database.
select is(
  (select count(*)::int from history_before b
   where not exists (
     select 1 from public.bill_occurrences o
     where o.id = b.id and o.bill_id = b.bill_id and o.due_date = b.due_date
       and o.status = b.status and o.amount_cents = b.amount_cents
       and o.transaction_id is not distinct from b.transaction_id
       and o.paid_on is not distinct from b.paid_on
       and o.created_at = b.created_at
   )),
  0,
  'every paid and skipped occurrence survives the rebuild byte for byte'
);

-- A metadata-only edit does not rebuild at all.
select ok(
  not (public.replace_bill('19000000-0000-4000-8000-000000000401', 'Rent (renamed)', 150000, 'monthly',
     '2026-01-31', null, null) ->> 'rebuilt')::boolean,
  'a name/category/account edit reports no rebuild'
);
select is(
  (select name from public.bills where id = '19000000-0000-4000-8000-000000000401'),
  'Rent (renamed)',
  'the metadata edit still applied'
);

-- A frequency + anchor change: the future follows the new terms exactly,
-- with no stale rows from the old series left behind.
--
-- The id set is snapshotted first, so the "no back-filled history"
-- assertion below can distinguish a row the rebuild *created* in the past
-- from one that was already there. That distinction is load-bearing
-- rather than pedantic: an old-series overdue occurrence can coincide
-- with a date on the new series purely by arithmetic (a monthly Jan-31
-- bill's July 31 is exactly thirty weeks after a Jan 2 weekly anchor), so
-- a date-shape test alone would report a preserved row as a fabricated
-- one.
create temporary table ids_before_refrequency on commit drop as
  select id from public.bill_occurrences where bill_id = '19000000-0000-4000-8000-000000000401';

select ok(
  (public.replace_bill('19000000-0000-4000-8000-000000000401', 'Rent', 150000, 'weekly',
     '2026-01-02', null, null) ->> 'rebuilt')::boolean,
  'a frequency and anchor change reports a rebuild'
);
select is(
  (select count(*)::int from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000401'
     and status = 'scheduled'
     and due_date >= (now() at time zone 'UTC')::date
     and (due_date - '2026-01-02'::date) % 7 <> 0),
  0,
  'no stale old-series scheduled row survives -- every future date is on the new weekly series'
);
select is(
  (select count(distinct due_date)::int from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000401'),
  (select count(*)::int from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000401'),
  'and the rebuild introduced no duplicate due dates'
);
select ok(
  (select min(due_date) from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000401'
     and status = 'scheduled'
     and due_date >= (now() at time zone 'UTC')::date)
  <= ((now() at time zone 'UTC')::date + 7),
  'the next scheduled date is correct immediately -- within a week for a weekly bill'
);
select is(
  (select amount_cents from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000401' and due_date = '2026-01-31'),
  120000::bigint,
  'the paid occurrence from the OLD series is still there, with its old amount'
);

-- No rebuild manufactures a past-dated obligation: every occurrence now
-- dated before the owner's today is one that already existed.
select is(
  (select count(*)::int from public.bill_occurrences o
   where o.bill_id = '19000000-0000-4000-8000-000000000401'
     and o.due_date < (now() at time zone 'UTC')::date
     and o.id not in (select id from ids_before_refrequency)),
  0,
  'the new series is not back-filled across dates that have already passed'
);

-- An invalid edit rolls the whole thing back.
-- An ARCHIVED category, which is the rule that does exist. (An income category
-- would be accepted, per the assertion above, so it cannot serve as the
-- rollback trigger.)
select throws_ok(
  $$ select public.replace_bill('19000000-0000-4000-8000-000000000401', 'Broken', 150000, 'weekly',
       '2026-01-02', '19000000-0000-4000-8000-0000000000c3', null) $$,
  '23514', null,
  'an edit naming an archived category is refused'
);
select is(
  (select name from public.bills where id = '19000000-0000-4000-8000-000000000401'),
  'Rent',
  'the refused edit left the bill exactly as it was'
);

-- ============================================================
-- Archive / unarchive
-- ============================================================

create temporary table occurrences_before_archive on commit drop as
  select id from public.bill_occurrences where bill_id = '19000000-0000-4000-8000-000000000401';

select lives_ok(
  $$ select public.set_bill_archived('19000000-0000-4000-8000-000000000401', true) $$,
  'a bill can be archived'
);
select is(
  (select count(*)::int from occurrences_before_archive b
   where not exists (select 1 from public.bill_occurrences o where o.id = b.id)),
  0,
  'archiving deletes no occurrence -- the whole history is retained'
);
select is(
  public.maintain_bill_schedule('19000000-0000-4000-8000-000000000401', false),
  0,
  'an archived bill generates nothing'
);
select throws_ok(
  $$ select public.replace_bill('19000000-0000-4000-8000-000000000401', 'x', 1, 'weekly',
       '2026-01-02', null, null) $$,
  '23514', null,
  'an archived bill cannot be edited -- unarchive it first'
);
select lives_ok(
  $$ select public.set_bill_archived('19000000-0000-4000-8000-000000000401', false) $$,
  'a bill can be unarchived'
);
select ok(
  exists (select 1 from public.bill_occurrences
          where bill_id = '19000000-0000-4000-8000-000000000401'
            and status = 'scheduled'
            and due_date >= (now() at time zone 'UTC')::date),
  'unarchiving restores a usable future horizon'
);
select is(
  (select amount_cents from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000401' and due_date = '2026-01-31'),
  120000::bigint,
  'and the paid history is still exactly where it was'
);

-- ============================================================
-- Cross-owner refusal, from every CP7 entry point
-- ============================================================

select throws_ok(
  $$ select public.replace_bill('19000000-0000-4000-8000-000000000201', 'stolen', 1, 'monthly',
       '2026-01-01', null, null) $$,
  '23503', null,
  'replace_bill refuses another owner''s bill'
);
select throws_ok(
  $$ select public.set_bill_archived('19000000-0000-4000-8000-000000000201', true) $$,
  '23503', null,
  'set_bill_archived refuses another owner''s bill'
);
select throws_ok(
  $$ select public.maintain_bill_schedule('19000000-0000-4000-8000-000000000201', true) $$,
  '23503', null,
  'maintain_bill_schedule refuses another owner''s bill -- the owner comes from the request claim'
);
select is(
  (select count(*)::int from public.bill_occurrences
   where user_id = '19000000-0000-4000-8000-000000000002'),
  0,
  'owner A cannot even see owner B''s occurrence -- RLS, before any of this'
);
select is(
  (select count(*)::int from public.bills where user_id <> '19000000-0000-4000-8000-000000000001'),
  0,
  'owner A sees only their own bills'
);

-- ...and B's row really is untouched, checked from outside RLS rather
-- than from a session that cannot see it either way.
reset role;
select is(
  (select count(*)::int from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000201' and status = 'scheduled'),
  1,
  'owner B''s scheduled occurrence survives every one of those attempts, unchanged'
);
select is(
  (select count(*)::int from public.bill_occurrences
   where bill_id = '19000000-0000-4000-8000-000000000201'),
  1,
  'and no occurrence was generated for B''s bill by A''s session'
);

-- ============================================================
-- The timezone boundary: owner B, fourteen hours ahead of UTC
-- ============================================================
-- Pacific/Kiritimati is UTC+14, so B's calendar day is *ahead* of UTC's
-- for ten hours out of every twenty-four. A paid_on of "UTC's tomorrow"
-- is therefore a legitimate "today" for B during that window, and a
-- ceiling read from `current_date` or from server UTC would refuse it.
--
-- Asserted conditionally on the window actually being open, because the
-- suite runs at whatever wall-clock time it runs: when B's local day is
-- ahead of UTC's, UTC-tomorrow must be accepted; the day *after* B's own
-- local day must be refused in either case, which is the half that holds
-- unconditionally.

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '19000000-0000-4000-8000-000000000002';

select is(
  (select auth.uid()),
  '19000000-0000-4000-8000-000000000002'::uuid,
  'auth.uid() reflects the request.jwt.claim.sub GUC for owner B'
);

select lives_ok(
  format(
    $$ update public.bill_occurrences set status = 'paid', paid_on = %L, transaction_id = null
       where id = '19000000-0000-4000-8000-000000000301' $$,
    (now() at time zone 'Pacific/Kiritimati')::date::text
  ),
  'owner B may record a payment on B''s OWN calendar day, even when that day is ahead of UTC''s'
);
select throws_ok(
  format(
    $$ update public.bill_occurrences set status = 'paid', paid_on = %L, transaction_id = null
       where id = '19000000-0000-4000-8000-000000000301' $$,
    ((now() at time zone 'Pacific/Kiritimati')::date + 1)::text
  ),
  '23514', null,
  'and may not record one on the day after B''s own -- the ceiling follows the owner, not the server'
);

-- The half that makes the first assertion meaningful rather than lucky:
-- when B is genuinely a day ahead, the date UTC calls "tomorrow" is
-- accepted, which a server-UTC ceiling would have refused.
select ok(
  (now() at time zone 'Pacific/Kiritimati')::date >= (now() at time zone 'UTC')::date,
  'Pacific/Kiritimati is never behind UTC -- the boundary fixture is the right way round'
);

reset role;

select * from finish();
rollback;
