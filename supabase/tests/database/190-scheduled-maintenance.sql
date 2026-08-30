-- Phase 7 Checkpoint 8A: unattended bill-schedule and current-snapshot
-- maintenance (`supabase/migrations/20260901120001_scheduled_maintenance.sql`).
--
-- Both `private.maintain_all_active_bill_schedules()` and
-- `private.refresh_all_current_net_worth_snapshots()` are SECURITY DEFINER,
-- owned by finance_snapshot_writer, and reuse Phase 4/CP7's own recurrence
-- and snapshot arithmetic unmodified -- this file proves what the daily loop
-- around them does, not the arithmetic itself (070-recurrence.sql and
-- 080-snapshots.sql already own that). Called here as the migration owner
-- (postgres), a member of finance_snapshot_writer, exactly as every private
-- writer call in this suite already is.
--
-- Fixture rows are scoped to their own owner ids throughout, and no
-- assertion depends on the total number of owners or bills in the database
-- -- the seeded fixture owner from supabase/seed.sql is present in every run
-- of this file and is deliberately left alone.
begin;
select plan(27);

-- ============================================================
-- Fixture: two owners, 25 hours apart (reusing 160's device), so each
-- one's own local month is a real discriminator rather than a coincidence.
-- ============================================================

insert into auth.users (id, aud, role, email) values
  ('1d000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'sched-e@local.test'),
  ('1d000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'sched-f@local.test');
insert into public.profiles (id, timezone) values
  ('1d000000-0000-4000-8000-000000000001', 'Pacific/Kiritimati'),
  ('1d000000-0000-4000-8000-000000000002', 'Pacific/Niue');

-- E: one healthy asset account. F: one account, negative enough that its
-- aggregate assets are negative from the moment it exists -- Guard 1 from
-- 160-current-snapshot.sql, reached the same ordinary way (a plain signed
-- opening balance, no per-type sign constraint).
insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('1d000000-0000-4000-8000-0000000000a1', '1d000000-0000-4000-8000-000000000001', 'E-checking', 'Bank', 'checking', 100000),
  ('1d000000-0000-4000-8000-0000000000a2', '1d000000-0000-4000-8000-000000000002', 'F-overdrawn', 'Bank', 'checking', -900000);

create temporary table sched_months on commit drop as
select p.id as owner_id, p.timezone, to_char((now() at time zone p.timezone)::date, 'YYYY-MM') as local_month
from public.profiles p
where p.id in ('1d000000-0000-4000-8000-000000000001', '1d000000-0000-4000-8000-000000000002');

-- ============================================================
-- Security posture: the two new functions, before either is ever called
-- ============================================================

select is(
  (select count(*)::int from pg_proc
   where proowner = 'finance_snapshot_writer'::regrole
     and prosecdef = true
     and proconfig::text like '%search_path=%'
     and oid in (
       'private.maintain_all_active_bill_schedules()'::regprocedure,
       'private.refresh_all_current_net_worth_snapshots()'::regprocedure
     )),
  2,
  'both maintenance functions are SECURITY DEFINER, owned by finance_snapshot_writer, with search_path pinned empty'
);

select ok(
  not has_function_privilege('authenticated', 'private.maintain_all_active_bill_schedules()'::regprocedure, 'execute')
  and not has_function_privilege('authenticated', 'private.refresh_all_current_net_worth_snapshots()'::regprocedure, 'execute')
  and not has_function_privilege('anon', 'private.maintain_all_active_bill_schedules()'::regprocedure, 'execute')
  and not has_function_privilege('anon', 'private.refresh_all_current_net_worth_snapshots()'::regprocedure, 'execute')
  and not has_function_privilege('public', 'private.maintain_all_active_bill_schedules()'::regprocedure, 'execute')
  and not has_function_privilege('public', 'private.refresh_all_current_net_worth_snapshots()'::regprocedure, 'execute'),
  'neither application role nor PUBLIC may EXECUTE either maintenance function'
);

-- `private` itself stays unreachable at the schema level for both roles --
-- restated here rather than assumed, so a caller of just this file still
-- gets the full claim.
select ok(not has_schema_privilege('authenticated', 'private', 'usage'), 'private schema still has no USAGE grant for authenticated');
select ok(not has_schema_privilege('anon', 'private', 'usage'), 'private schema still has no USAGE grant for anon');

-- CP5's own narrow profiles policy is completely unmodified by this
-- migration -- restated as a fresh behavioral proof, not merely inferred
-- from the migration diff. A claimless session (exactly what pg_cron's own
-- connection looks like before either function below sets a claim) sees
-- zero rows, precisely as 090-privileges.sql already pins.
--
-- pgTAP's own assertion functions live in `extensions`, which
-- finance_snapshot_writer has no USAGE on (it is a role this schema
-- created, not a Supabase built-in) -- so this grant is a test-harness
-- concern only, exactly as 090-privileges.sql already documents and relies
-- on, rolled back with everything else in this file.
grant usage on schema extensions to finance_snapshot_writer;
set local role finance_snapshot_writer;
select is(
  (select count(*)::int from public.profiles),
  0,
  'CP8A does not widen finance_snapshot_writer''s profiles policy -- a claimless session still sees zero rows'
);
reset role;

-- The extension and both daily jobs exist, are owned by the unavoidable
-- (non-superuser) scheduling role, and address nothing a client could have
-- supplied -- the command strings are fixed literals with no parameter.
select ok(
  exists (select 1 from pg_extension where extname = 'pg_cron'),
  'pg_cron is installed'
);
select is(
  (select count(*)::int from cron.job
   where jobname in ('bill-schedule-maintenance', 'current-snapshot-maintenance')
     and username = 'postgres'
     and active),
  2,
  'both daily jobs exist, active, running as the migration role (pg_cron requires an actual superuser to run a job as any other role)'
);
select is(
  (select command from cron.job where jobname = 'bill-schedule-maintenance'),
  ' select private.maintain_all_active_bill_schedules(); ',
  'the bill job''s command is the fixed, parameterless call and nothing else'
);
select is(
  (select command from cron.job where jobname = 'current-snapshot-maintenance'),
  ' select private.refresh_all_current_net_worth_snapshots(); ',
  'the snapshot job''s command is the fixed, parameterless call and nothing else'
);

-- ============================================================
-- Bill-schedule maintenance
-- ============================================================

-- B1: active, anchored in the past, zero occurrences yet -- exactly the
-- "created outside any request, never touched again" shape CP7 documents
-- as the gap this checkpoint closes.
insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date) values
  ('1d000000-0000-4000-8000-0000000000b1', '1d000000-0000-4000-8000-000000000001', 'E-Untouched', 500, 'monthly', '2025-01-31');

-- B2: active, with one paid and one skipped occurrence already on record.
insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date) values
  ('1d000000-0000-4000-8000-0000000000b2', '1d000000-0000-4000-8000-000000000001', 'E-History', 700, 'monthly', '2026-06-15');
insert into public.bill_occurrences (id, user_id, bill_id, due_date, status, amount_cents, paid_on) values
  ('1d000000-0000-4000-8000-0000000000c1', '1d000000-0000-4000-8000-000000000001', '1d000000-0000-4000-8000-0000000000b2', '2026-06-15', 'paid', 700, '2026-06-15'),
  ('1d000000-0000-4000-8000-0000000000c2', '1d000000-0000-4000-8000-000000000001', '1d000000-0000-4000-8000-0000000000b2', '2026-07-15', 'skipped', 700, null);

-- B3: archived, anchored in the past, zero occurrences -- must gain none.
insert into public.bills (id, user_id, name, amount_cents, frequency, anchor_date, is_archived) values
  ('1d000000-0000-4000-8000-0000000000b3', '1d000000-0000-4000-8000-000000000001', 'E-Archived', 900, 'monthly', '2025-01-31', true);

select private.maintain_all_active_bill_schedules();

select ok(
  (select count(*)::int from public.bill_occurrences where bill_id = '1d000000-0000-4000-8000-0000000000b1') > 0,
  'an untouched active bill gains scheduled occurrences from unattended maintenance'
);
select is(
  (select count(*)::int from public.bill_occurrences where bill_id = '1d000000-0000-4000-8000-0000000000b3'),
  0,
  'an archived bill gains none'
);
select results_eq(
  $$ select status, amount_cents, paid_on from public.bill_occurrences
     where id in ('1d000000-0000-4000-8000-0000000000c1', '1d000000-0000-4000-8000-0000000000c2')
     order by id $$,
  $$ values ('paid'::public.bill_occurrence_status, 700::bigint, '2026-06-15'::date),
            ('skipped'::public.bill_occurrence_status, 700::bigint, null::date) $$,
  'paid and skipped history is untouched by maintenance'
);

-- Every generated occurrence for B1 lands on the real monthly anchor day
-- (the 31st, or the last day of a shorter month) -- proof that the daily
-- job calls the same clamping arithmetic 070-recurrence.sql already owns,
-- rather than approximating it.
select ok(
  (select bool_and(due_date = (date_trunc('month', due_date) + interval '1 month - 1 day')::date)
   from public.bill_occurrences
   where bill_id = '1d000000-0000-4000-8000-0000000000b1'),
  'a bill anchored on the 31st stays clamped to each month''s real last day throughout -- no drift onto the 1st of the next month'
);

create temporary table bill_counts_after_first_run on commit drop as
select bill_id, count(*) as n from public.bill_occurrences
where bill_id in ('1d000000-0000-4000-8000-0000000000b1', '1d000000-0000-4000-8000-0000000000b2')
group by bill_id;

select private.maintain_all_active_bill_schedules();

select results_eq(
  $$ select bill_id, count(*) as n from public.bill_occurrences
     where bill_id in ('1d000000-0000-4000-8000-0000000000b1', '1d000000-0000-4000-8000-0000000000b2')
     group by bill_id order by bill_id $$,
  $$ select bill_id, n from bill_counts_after_first_run order by bill_id $$,
  'repeated maintenance is idempotent -- no duplicate occurrences on a second pass'
);

-- The claim GUC set for one bill's owner never leaks into the caller's own
-- session once the function returns.
select is(current_setting('request.jwt.claim.sub', true), '', 'the impersonation claim is cleared after the bill job returns');

-- ============================================================
-- Current-snapshot maintenance
-- ============================================================

-- A stale-looking prior value for E, so "refreshed in place" is a real
-- comparison rather than "a row appeared".
insert into public.net_worth_snapshots (user_id, month, assets_cents, liabilities_cents, net_worth_cents) values
  ('1d000000-0000-4000-8000-000000000001', (select local_month from sched_months where owner_id = '1d000000-0000-4000-8000-000000000001'), 1, 0, 1);

select private.refresh_all_current_net_worth_snapshots();

-- E: healthy owner, refreshed to the live figure (100000), in E's own
-- local month -- not server UTC's.
select is(
  (select assets_cents from public.net_worth_snapshots
   where user_id = '1d000000-0000-4000-8000-000000000001'
     and month = (select local_month from sched_months where owner_id = '1d000000-0000-4000-8000-000000000001')),
  100000::bigint,
  'an existing current-month row is refreshed to the live total, in the owner''s own local month'
);

-- F: the sign guard fires (aggregate assets negative), and F had no prior
-- snapshot row at all -- "missing, stays missing" rather than a corrupted
-- write.
select is(
  (select count(*)::int from public.net_worth_snapshots where user_id = '1d000000-0000-4000-8000-000000000002'),
  0,
  'a sign-guard owner with no prior snapshot gets none written -- missing stays missing, never a partial row'
);

-- F's ledger is untouched -- the maintenance job writes no transaction, no
-- account, nothing but net_worth_snapshots.
select is(
  (select count(*)::int from public.transactions where user_id = '1d000000-0000-4000-8000-000000000002'),
  0,
  'the sign-guard owner''s ledger has no rows at all -- maintenance did not create or touch one'
);

-- Both E (healthy) and F (sign-guard) were considered in the SAME call --
-- proof that one owner's failure did not stop the other from being
-- attempted.
select ok(
  (select (private.refresh_all_current_net_worth_snapshots() ->> 'owners_skipped_sign_guard')::int) >= 1,
  'the sign-guard owner is counted rather than raising out of the whole job'
);
select is(
  (select assets_cents from public.net_worth_snapshots
   where user_id = '1d000000-0000-4000-8000-000000000001'
     and month = (select local_month from sched_months where owner_id = '1d000000-0000-4000-8000-000000000001')),
  100000::bigint,
  'and E''s already-healthy row is unchanged by that same call -- idempotent'
);

-- Now give F a small, valid snapshot for its current month (simulating an
-- earlier healthy write), then re-trigger the sign guard and confirm that
-- row survives byte for byte -- "stale, never corrupted", the same
-- guarantee 160-current-snapshot.sql already proves for the request-driven
-- bridge, proved here for the unattended one.
delete from public.accounts where id = '1d000000-0000-4000-8000-0000000000a2';
insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('1d000000-0000-4000-8000-0000000000a3', '1d000000-0000-4000-8000-000000000002', 'F-healthy', 'Bank', 'checking', 5000);
select private.refresh_all_current_net_worth_snapshots();
select is(
  (select assets_cents from public.net_worth_snapshots
   where user_id = '1d000000-0000-4000-8000-000000000002'
     and month = (select local_month from sched_months where owner_id = '1d000000-0000-4000-8000-000000000002')),
  5000::bigint,
  'F recovers once its aggregate is valid again -- the next attempt succeeds without any repair step'
);

create temporary table f_snapshot_before_guard on commit drop as
select month, assets_cents, liabilities_cents, net_worth_cents
from public.net_worth_snapshots where user_id = '1d000000-0000-4000-8000-000000000002';

insert into public.accounts (id, user_id, name, institution, type, opening_balance_cents) values
  ('1d000000-0000-4000-8000-0000000000a4', '1d000000-0000-4000-8000-000000000002', 'F-overdrawn-again', 'Bank', 'checking', -900000);

select private.refresh_all_current_net_worth_snapshots();

select results_eq(
  $$ select month, assets_cents, liabilities_cents, net_worth_cents
     from public.net_worth_snapshots where user_id = '1d000000-0000-4000-8000-000000000002' $$,
  $$ select month, assets_cents, liabilities_cents, net_worth_cents from f_snapshot_before_guard $$,
  'a sign-guard failure on a previously-healthy owner leaves that owner''s existing row byte for byte unchanged'
);

select is(current_setting('request.jwt.claim.sub', true), '', 'the impersonation claim is cleared after the snapshot job returns too');

-- ============================================================
-- No new writable surface for application roles anywhere in this migration
-- ============================================================

select is(
  (select count(*)::int from (values
    ('profiles'), ('net_worth_snapshots')
  ) as t(name)
  where has_table_privilege('authenticated', 'public.' || t.name, 'insert')
     or has_table_privilege('authenticated', 'public.' || t.name, 'update')
     or has_table_privilege('authenticated', 'public.' || t.name, 'delete')),
  0,
  'authenticated still has no INSERT/UPDATE/DELETE on profiles or net_worth_snapshots'
);
select ok(
  not has_table_privilege('anon', 'public.bill_occurrences', 'insert')
  and not has_table_privilege('anon', 'public.bill_occurrences', 'delete')
  and not has_table_privilege('authenticated', 'public.bill_occurrences', 'insert')
  and not has_table_privilege('authenticated', 'public.bill_occurrences', 'delete'),
  'neither application role gained INSERT or DELETE on bill_occurrences'
);

-- finance_snapshot_writer's own attributes, restated one more time: this
-- migration adds callers, not power. No login, no superuser, no RLS bypass.
select ok(
  (select not rolcanlogin and not rolsuper and not rolbypassrls
   from pg_roles where rolname = 'finance_snapshot_writer'),
  'finance_snapshot_writer is still NOLOGIN, NOSUPERUSER and NOBYPASSRLS after CP8A'
);

-- postgres itself gained no new standing privilege from this migration --
-- it can call the two new functions only because it already inherits
-- finance_snapshot_writer's own EXECUTE-on-its-own-functions, established
-- in migration 7 and unchanged here. pg_has_role() is the canonical check
-- (rather than counting pg_auth_members rows directly, which can carry more
-- than one row per membership pair once ADMIN OPTION and INHERIT were
-- granted separately).
select ok(
  pg_has_role('postgres', 'finance_snapshot_writer', 'member')
  and pg_has_role('postgres', 'finance_snapshot_writer', 'usage'),
  'postgres reaches the two new functions via the same pre-existing membership CP4 already relies on -- no new grant was needed or added'
);

select * from finish();
rollback;
