-- Phase 7 Checkpoint 5: the current-month net-worth snapshot bridge.
--
-- `public.refresh_current_net_worth_snapshot()` is the one SECURITY
-- DEFINER function this phase adds and the only one `authenticated` can
-- reach. Its privilege posture -- owner, zero parameters, EXECUTE
-- granted to `authenticated` alone, revoked from PUBLIC and anon, the
-- private writers still unreachable, the writer role's own attributes,
-- the column-scoped profiles grant -- is asserted in
-- 090-privileges.sql. This file is about what it *does*.
--
-- ============================================================
-- On the timezone-boundary case, and why it is proved in two halves
-- ============================================================
--
-- The requirement is that the month be derived from the OWNER's profile
-- timezone and never from server UTC. Proving that with a live clock has
-- a hard limit worth stating rather than papering over: `now()` cannot be
-- faked inside a transaction, and no timezone on Earth is in a different
-- *month* from UTC except within a few hours of a month boundary. A test
-- that waited for the calendar to cooperate would pass vacuously for
-- twenty-eight days a month, which is worse than no test.
--
-- So the claim is split into two halves that are each unconditional:
--
--   1. THE DERIVATION IS TIMEZONE-DRIVEN, AT DAY GRANULARITY. Two owners
--      are placed in Pacific/Kiritimati (UTC+14) and Pacific/Niue
--      (UTC-11) -- 25 hours apart, which means their local calendar
--      dates ALWAYS differ, at every instant, with no boundary luck
--      required. Each owner's snapshot month is asserted against that
--      owner's *own* local date. A function reading server UTC would
--      write the same month for both; a function reading the profile
--      writes each owner's own, and on the days when those months
--      differ this assertion is the difference.
--
--   2. THE DATE->MONTH STEP IS CORRECT ACROSS A BOUNDARY, at a fixed
--      instant chosen precisely to straddle one. That half needs no
--      clock at all, so it is exact every time: at 2026-08-31 23:30 UTC
--      it is already September in Kiritimati and still August in Niue,
--      and the same expression the function uses says so.
--
-- Together those cover what a single flaky assertion would have covered
-- only sometimes.
begin;
select plan(33);

-- ============================================================
-- Fixture: two owners, 25 hours apart, with identical finances
-- ============================================================
-- Identical balances on purpose: the only thing that can make their
-- snapshots differ is the timezone, so any difference below is
-- attributable to exactly one cause.

insert into auth.users (id, aud, role, email) values
  ('1c000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'snap-c@local.test'),
  ('1c000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'snap-d@local.test');
insert into public.profiles (id, timezone) values
  ('1c000000-0000-4000-8000-000000000001', 'Pacific/Kiritimati'),
  ('1c000000-0000-4000-8000-000000000002', 'Pacific/Niue');

-- C: two asset accounts, two liability accounts, and one archived
-- account whose balance is large enough that wrongly including it would
-- be unmissable. Classification mirrors lib/finance/accounts.ts exactly:
-- credit and loan are liabilities, everything else is an asset, archived
-- is excluded.
insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents, is_archived) values
  ('1c000000-0000-4000-8000-0000000000a1', '1c000000-0000-4000-8000-000000000001', 'C-checking', 'Bank', 'checking', 100000, false),
  ('1c000000-0000-4000-8000-0000000000a2', '1c000000-0000-4000-8000-000000000001', 'C-savings', 'Bank', 'savings', 50000, false),
  ('1c000000-0000-4000-8000-0000000000a3', '1c000000-0000-4000-8000-000000000001', 'C-card', 'Bank', 'credit', -20000, false),
  ('1c000000-0000-4000-8000-0000000000a4', '1c000000-0000-4000-8000-000000000001', 'C-loan', 'Bank', 'loan', -30000, false),
  ('1c000000-0000-4000-8000-0000000000a5', '1c000000-0000-4000-8000-000000000001', 'C-archived', 'Bank', 'checking', 99999999, true),
  ('1c000000-0000-4000-8000-0000000000b1', '1c000000-0000-4000-8000-000000000002', 'D-checking', 'Bank', 'checking', 100000, false);

-- Dated well in the past, so every one of them is inside the as-of
-- window for the current month's last calendar day, in either owner's
-- timezone. The adjustment is here deliberately: CP5's reconciliation
-- writes exactly this kind of row, and a snapshot that excluded it the
-- way the income/spending rollups do would report a balance the account
-- page does not show.
insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents) values
  ('1c000000-0000-4000-8000-0000000000f1', '1c000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000a1', '2026-01-05', 'C-expense', 'expense', -1000),
  ('1c000000-0000-4000-8000-0000000000f2', '1c000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000a3', '2026-01-06', 'Balance adjustment', 'adjustment', 5000);

-- A prior-month snapshot with deliberately wrong figures. CP5 refreshes
-- the CURRENT month only and repairs no history, so this row must come
-- through the refresh below byte for byte. Written directly as the
-- migration owner, which is a member of finance_snapshot_writer.
insert into public.net_worth_snapshots (user_id, month, assets_cents, liabilities_cents, net_worth_cents) values
  ('1c000000-0000-4000-8000-000000000001', '2020-01', 111, 222, -111);

-- Each owner's own current month, derived exactly as the function does.
-- A temporary table rather than repeated inline expressions, so every
-- assertion below compares against one evaluation of one expression.
create temporary table snap_months on commit drop as
select
  p.id as owner_id,
  p.timezone,
  (now() at time zone p.timezone)::date as local_date,
  to_char((now() at time zone p.timezone)::date, 'YYYY-MM') as local_month
from public.profiles p
where p.id in ('1c000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-000000000002');

-- ============================================================
-- Half 2 of the timezone claim: the date -> month step, at a fixed
-- instant that straddles a boundary. No clock involved, so this is
-- exact on every run.
-- ============================================================

select is(
  to_char((timestamptz '2026-08-31 23:30:00+00' at time zone 'Pacific/Kiritimati')::date, 'YYYY-MM'),
  '2026-09',
  'at 2026-08-31 23:30 UTC it is already September in Kiritimati (UTC+14)'
);
select is(
  to_char((timestamptz '2026-08-31 23:30:00+00' at time zone 'Pacific/Niue')::date, 'YYYY-MM'),
  '2026-08',
  'and still August in Niue (UTC-11) -- the same instant, two months'
);
select is(
  to_char((timestamptz '2026-08-31 23:30:00+00' at time zone 'UTC')::date, 'YYYY-MM'),
  '2026-08',
  'a server-UTC derivation would have given Kiritimati the wrong month'
);

-- Half 1's precondition, asserted rather than assumed: 25 hours apart
-- means these two owners are never on the same calendar date, at any
-- instant. That is what makes the per-owner assertions below a real
-- discriminator instead of a coincidence.
select isnt(
  (select local_date from snap_months where owner_id = '1c000000-0000-4000-8000-000000000001'),
  (select local_date from snap_months where owner_id = '1c000000-0000-4000-8000-000000000002'),
  'the two owners are always on different calendar dates -- 25 hours apart'
);

-- ============================================================
-- private.request_owner_id() == auth.uid()
-- ============================================================
-- The bridge cannot call auth.uid(): inside a SECURITY DEFINER body the
-- current role is finance_snapshot_writer, which has no USAGE on schema
-- `auth` -- and that USAGE cannot be granted by the migration role,
-- since schema auth belongs to supabase_auth_admin. So the bridge reads
-- the same GUCs auth.uid() reads. This is the assertion that keeps that
-- duplicate honest: if Supabase ever changes how the claim is exposed,
-- these two stop agreeing here rather than silently in production.

set local request.jwt.claim.sub = '1c000000-0000-4000-8000-000000000001';
select is(
  private.request_owner_id(),
  auth.uid(),
  'request_owner_id() agrees with auth.uid() for a set claim'
);
select is(
  private.request_owner_id(),
  '1c000000-0000-4000-8000-000000000001'::uuid,
  'and it is the claim''s own subject, not some other owner'
);

set local request.jwt.claim.sub = '';
select is(
  private.request_owner_id(),
  auth.uid(),
  'request_owner_id() agrees with auth.uid() for an empty claim (both null)'
);
select ok(
  private.request_owner_id() is null,
  'and an empty claim really does produce null rather than an error'
);

-- The JSON-claims form, which is what PostgREST actually sets in
-- production (`request.jwt.claims`), as opposed to the flattened
-- `request.jwt.claim.sub` the rest of this suite uses.
set local request.jwt.claims = '{"sub":"1c000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(
  private.request_owner_id(),
  auth.uid(),
  'request_owner_id() agrees with auth.uid() for the JSON claims form too'
);
select is(
  private.request_owner_id(),
  '1c000000-0000-4000-8000-000000000002'::uuid,
  'and reads `sub` out of it correctly'
);

reset role;
set local request.jwt.claims = '';

-- ============================================================
-- The refresh, as owner C
-- ============================================================

set local role authenticated;
set local request.jwt.claim.sub = '1c000000-0000-4000-8000-000000000001';

select lives_ok(
  $$ select public.refresh_current_net_worth_snapshot() $$,
  'an authenticated owner can refresh their own current-month snapshot'
);

reset role;

-- Half 1 of the timezone claim: the month written is C's own local
-- month, from C's own profile timezone.
select is(
  (select month from public.net_worth_snapshots
   where user_id = '1c000000-0000-4000-8000-000000000001' and month <> '2020-01'),
  (select local_month from snap_months where owner_id = '1c000000-0000-4000-8000-000000000001'),
  'the snapshot lands in the owner''s own local month, derived from their profile timezone'
);

-- Exactly one month was written. The caller cannot address another one,
-- because the function takes no month -- so a second row could only come
-- from the function deciding to write one.
select is(
  (select count(*)::int from public.net_worth_snapshots
   where user_id = '1c000000-0000-4000-8000-000000000001' and month <> '2020-01'),
  1,
  'exactly one month is written -- the caller cannot address another'
);

-- The values, hand-computed from the fixture:
--   assets      = (100000 - 1000) + 50000            = 149000
--   liabilities = -((-20000 + 5000) + (-30000))      =  45000
--   net worth   = 149000 - 45000                     = 104000
-- The archived account's 99999999 appears in none of them.
select is(
  (select assets_cents from public.net_worth_snapshots
   where user_id = '1c000000-0000-4000-8000-000000000001'
     and month = (select local_month from snap_months where owner_id = '1c000000-0000-4000-8000-000000000001')),
  149000::bigint,
  'assets match current account/transaction state, with the archived account excluded'
);
select is(
  (select liabilities_cents from public.net_worth_snapshots
   where user_id = '1c000000-0000-4000-8000-000000000001'
     and month = (select local_month from snap_months where owner_id = '1c000000-0000-4000-8000-000000000001')),
  45000::bigint,
  'liabilities are a positive magnitude, and the CP5 adjustment moved one of them'
);
select is(
  (select net_worth_cents from public.net_worth_snapshots
   where user_id = '1c000000-0000-4000-8000-000000000001'
     and month = (select local_month from snap_months where owner_id = '1c000000-0000-4000-8000-000000000001')),
  104000::bigint,
  'net worth is assets minus liabilities, stored rather than implied'
);

-- Prior months are not repaired, rebuilt, or touched. CP5 accepts that
-- limitation explicitly: live derived balances are authoritative and the
-- snapshot series is a secondary trend.
select results_eq(
  $$ select assets_cents, liabilities_cents, net_worth_cents
     from public.net_worth_snapshots
     where user_id = '1c000000-0000-4000-8000-000000000001' and month = '2020-01' $$,
  $$ values (111::bigint, 222::bigint, -111::bigint) $$,
  'a prior month''s snapshot is left exactly as it was -- CP5 repairs no history'
);

-- The caller cannot address another owner, because the function takes no
-- owner. D has finances and no snapshot.
select is(
  (select count(*)::int from public.net_worth_snapshots
   where user_id = '1c000000-0000-4000-8000-000000000002'),
  0,
  'refreshing as C wrote nothing for D -- the caller cannot choose an owner'
);

-- ============================================================
-- Idempotence
-- ============================================================
-- The writer recomputes the whole month from current state and upserts
-- on (user_id, month), so calling twice in a row is the same as calling
-- once. That is what lets every balance-affecting mutation call it
-- unconditionally without coordinating with any other.

create temporary table snap_before on commit drop as
select month, assets_cents, liabilities_cents, net_worth_cents
from public.net_worth_snapshots
where user_id = '1c000000-0000-4000-8000-000000000001';

set local role authenticated;
select public.refresh_current_net_worth_snapshot();
select public.refresh_current_net_worth_snapshot();
reset role;

select results_eq(
  $$ select month, assets_cents, liabilities_cents, net_worth_cents
     from public.net_worth_snapshots
     where user_id = '1c000000-0000-4000-8000-000000000001' order by month $$,
  $$ select month, assets_cents, liabilities_cents, net_worth_cents
     from snap_before order by month $$,
  'refreshing repeatedly for the same current month changes nothing'
);

-- And it tracks state: a new transaction changes the figures the very
-- next refresh produces, which is the whole reason the mutation layer
-- calls it after every balance-affecting write.
insert into public.transactions (id, user_id, account_id, date, merchant, kind, amount_cents) values
  ('1c000000-0000-4000-8000-0000000000f3', '1c000000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-0000000000a2', '2026-01-07', 'C-income', 'income', 25000);

set local role authenticated;
select public.refresh_current_net_worth_snapshot();
reset role;

select is(
  (select assets_cents from public.net_worth_snapshots
   where user_id = '1c000000-0000-4000-8000-000000000001'
     and month = (select local_month from snap_months where owner_id = '1c000000-0000-4000-8000-000000000001')),
  174000::bigint,
  'a later refresh picks up a newly written ledger row'
);

-- ============================================================
-- No profile, no snapshot
-- ============================================================
-- A verified caller with no profiles row is a provisioning failure, not
-- a no-op -- the same stance getToday() takes. A snapshot silently not
-- written is exactly the failure a trend chart cannot show.

set local role authenticated;
set local request.jwt.claim.sub = '1c000000-0000-4000-8000-000000000003';
select throws_ok(
  $$ select public.refresh_current_net_worth_snapshot() $$,
  'P0002', null,
  'a caller with no profile row is refused rather than silently skipped'
);

set local request.jwt.claim.sub = '';
select throws_ok(
  $$ select public.refresh_current_net_worth_snapshot() $$,
  '28000', null,
  'a session with no verified claim cannot refresh anything'
);

reset role;

-- ============================================================
-- No historical rebuild surface exists
-- ============================================================
-- CP5 adds one bridge and no other reachable snapshot entry point. In
-- particular there is no wrapper over
-- private.write_net_worth_snapshots_for_range, and none over the
-- single-month writer that takes a user or a month: backfill stays an
-- operator action.

select is(
  (select string_agg(p.proname::text, ',' order by p.proname)
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like '%snapshot%'),
  'refresh_current_net_worth_snapshot',
  'public exposes exactly one snapshot function, and it is the zero-argument bridge'
);

-- FORCE RLS is unchanged on every table the bridge or its writer can
-- reach. A definer function whose owner is subject to RLS is only as
-- safe as that RLS, so this is load-bearing rather than tidy.
select is(
  (select count(*)::int from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('profiles', 'accounts', 'transactions', 'net_worth_snapshots')
     and c.relrowsecurity and c.relforcerowsecurity),
  4,
  'RLS is still enabled AND forced on every table the snapshot bridge can reach'
);

-- The writer's own attributes, restated here because this is the file
-- where a reader asks "what does the definer's identity actually buy an
-- attacker?" The answer must stay: no login, no superuser, no RLS
-- bypass. 090-privileges.sql asserts the same three alongside the rest
-- of the role's posture.
select ok(
  (select not rolcanlogin and not rolsuper and not rolbypassrls
   from pg_roles where rolname = 'finance_snapshot_writer'),
  'finance_snapshot_writer is still NOLOGIN, NOSUPERUSER and NOBYPASSRLS'
);

-- ============================================================
-- The two sign guards Phase 4's writer carries, and what they mean
-- for CP5
-- ============================================================
-- `private.write_net_worth_snapshot` raises rather than storing either
-- magnitude negative:
--
--     if v_assets_cents < 0      then raise ... 'data_exception'
--     if v_liabilities_cents < 0 then raise ... 'data_exception'
--
-- Those guards were written in Phase 4, when nothing in the application
-- could produce either state and nothing called the writer at all. CP4
-- and CP5 changed the first half of that: a card payment can overpay a
-- card, an account can be opened at a negative balance, an ordinary
-- expense can overdraw a checking account, and a reconciliation can set
-- an asset account negative or a liability to zero. CP5 changed the
-- second half by calling the writer after every balance-affecting write.
--
-- So both guards are now reachable, and this section pins exactly what
-- happens when they fire. It is a *characterization* of Phase 4
-- behavior, deliberately not a change to it: nothing here weakens a
-- constraint or reclassifies an account type.
--
-- The two states are not equally likely. Aggregate assets go negative
-- only when the owner's entire asset position is negative -- one
-- overdrawn current account and no savings, which is an ordinary
-- personal-finance situation. Aggregate liabilities go negative only
-- when an overpaid card is not offset by any other debt.

-- ---------- Guard 1: aggregate assets negative ----------
-- A new account for owner C, negative enough to outweigh every asset C
-- has. Nothing about this insert is exotic: `opening_balance_cents` is a
-- plain signed bigint with no per-type sign constraint, and
-- `lib/validation/accounts.ts` accepts a signed opening balance for
-- every type (`zOpeningBalance = zMoneyCents({ allowNegative: true })`).
insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('1c000000-0000-4000-8000-0000000000a6', '1c000000-0000-4000-8000-000000000001', 'C-overdrawn', 'Bank', 'checking', -900000);

-- C's current snapshot, captured before the failing refresh so
-- "stale, not corrupted" is a comparison rather than an assertion about
-- nothing.
create temporary table snap_guard_before on commit drop as
select month, assets_cents, liabilities_cents, net_worth_cents
from public.net_worth_snapshots
where user_id = '1c000000-0000-4000-8000-000000000001';

select throws_ok(
  $$ select private.write_net_worth_snapshot('1c000000-0000-4000-8000-000000000001'::uuid,
       to_char((now() at time zone 'Pacific/Kiritimati')::date, 'YYYY-MM')) $$,
  '22000', null,
  'the writer refuses to store a negative aggregate asset magnitude'
);

-- The refusal happens before the INSERT ... ON CONFLICT, so an existing
-- row is left exactly as it was. That is the property that makes the
-- application-layer behavior acceptable: a failed refresh leaves the
-- trend *stale*, never wrong.
select results_eq(
  $$ select month, assets_cents, liabilities_cents, net_worth_cents
     from public.net_worth_snapshots
     where user_id = '1c000000-0000-4000-8000-000000000001' order by month $$,
  $$ select month, assets_cents, liabilities_cents, net_worth_cents
     from snap_guard_before order by month $$,
  'and leaves every existing snapshot row untouched -- stale, not corrupted'
);

-- The public bridge is a thin wrapper, so it surfaces the same refusal
-- to `authenticated` rather than swallowing it. Swallowing is the
-- *application* layer's job (lib/data/mutations/snapshots.ts), and it is
-- deliberately not the database's.
set local role authenticated;
set local request.jwt.claim.sub = '1c000000-0000-4000-8000-000000000001';
select throws_ok(
  $$ select public.refresh_current_net_worth_snapshot() $$,
  '22000', null,
  'the CP5 bridge surfaces the same refusal rather than hiding it'
);
reset role;

-- Recovery is an ordinary supported write: bring the account back to
-- zero and the very next refresh succeeds. Nothing has to be repaired,
-- because the writer recomputes the whole month from current state.
update public.accounts set opening_balance_cents = 0
where id = '1c000000-0000-4000-8000-0000000000a6';

select lives_ok(
  $$ select private.write_net_worth_snapshot('1c000000-0000-4000-8000-000000000001'::uuid,
       to_char((now() at time zone 'Pacific/Kiritimati')::date, 'YYYY-MM')) $$,
  'and the next refresh succeeds once the aggregate is non-negative again'
);

-- ---------- Guard 2: aggregate liabilities negative ----------
-- Owner D, reached the realistic way: a credit-card payment larger than
-- the card owes, with no other debt to offset it. Written through
-- `public.create_movement` as `authenticated`, so this is the actual
-- CP4 path and not a hand-built fixture.
insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('1c000000-0000-4000-8000-0000000000b2', '1c000000-0000-4000-8000-000000000002', 'D-card', 'Bank', 'credit', -20000);

set local role authenticated;
set local request.jwt.claim.sub = '1c000000-0000-4000-8000-000000000002';
select lives_ok(
  format(
    $$ select public.create_movement(
         '1c000000-0000-4000-8000-0000000000e1'::uuid, 'credit_card_payment'::public.movement_kind,
         %L::date,
         '1c000000-0000-4000-8000-0000000000b1'::uuid, '1c000000-0000-4000-8000-0000000000b2'::uuid,
         50000,
         '1c000000-0000-4000-8000-0000000000e2'::uuid, '1c000000-0000-4000-8000-0000000000e3'::uuid) $$,
    (select (now() at time zone 'Pacific/Niue')::date)
  ),
  'overpaying a credit card is a legal, supported CP4 write'
);
reset role;

select is(
  (select balance_cents from public.account_balances where id = '1c000000-0000-4000-8000-0000000000b2'),
  30000::bigint,
  'the card is now overpaid -- a positive balance on a credit account, which nothing forbids'
);

select throws_ok(
  $$ select private.write_net_worth_snapshot('1c000000-0000-4000-8000-000000000002'::uuid,
       to_char((now() at time zone 'Pacific/Niue')::date, 'YYYY-MM')) $$,
  '22000', null,
  'the writer refuses to store a negative aggregate liability magnitude'
);

select is(
  (select count(*)::int from public.net_worth_snapshots
   where user_id = '1c000000-0000-4000-8000-000000000002'),
  0,
  'and wrote no row at all for that owner'
);

select * from finish();
rollback;
