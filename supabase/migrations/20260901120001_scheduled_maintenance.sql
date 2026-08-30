-- Phase 7 Checkpoint 8A: unattended maintenance, scheduled by the database
-- itself rather than by any request the application makes.
--
-- Two gaps survive CP5/CP7 as long as maintenance only ever runs inside a
-- mutation:
--
--   * A bill nobody touches for a year runs out of scheduled occurrences
--     (CP7's own documented limitation).
--   * A new month begins, or a prior refresh failed, with no further
--     balance-affecting write to trigger a recompute -- so the current
--     month's net-worth snapshot can sit stale indefinitely with nobody
--     online to fix it.
--
-- This migration adds exactly two pieces of unattended machinery and nothing
-- else: pg_cron, and two `private` functions it calls once a day. No table
-- gains a grant for `authenticated` or `anon`. No existing function, policy,
-- grant, or role attribute from any earlier migration is edited.
--
-- ============================================================
-- These two jobs execute as `postgres`, and why that is fine
-- ============================================================
--
-- pg_cron records the scheduling session's current_user as the job's
-- `username` and executes the job with that role's permissions -- it does
-- not inherently pin every job to any one identity. It also supports
-- scheduling a job to run as a role *other* than the one that scheduled it
-- (`cron.schedule_in_database`'s `username` argument), but that override
-- requires the scheduling role to be an actual database superuser --
-- verified directly against this local image:
--
--     select cron.schedule_in_database('x', '* * * * *', 'select 1',
--       'postgres', 'finance_snapshot_writer');
--     ERROR:  must be superuser to create a job for another role
--
-- This migration runs as `postgres`, which is NOSUPERUSER here (matching
-- Phase 4's own documented finding for this database) and stays that way, so
-- it never requests that override. The two `cron.schedule(...)` calls below
-- are therefore scheduled by the migration as `postgres`, with no `username`
-- override, so both jobs execute as `postgres` -- which also carries
-- BYPASSRLS, per Phase 4's own note ("postgres itself is
-- NOSUPERUSER/BYPASSRLS, not a superuser"). Running the actual maintenance
-- SQL directly as that role would give it the same unrestricted reach as a
-- migration.
--
-- So neither scheduled command below is the maintenance logic itself. Each
-- is a single call to a `private`, SECURITY DEFINER function owned by the
-- existing `finance_snapshot_writer` -- the same NOLOGIN/NOSUPERUSER/
-- NOBYPASSRLS role CP5 and CP7 already trust, with no new role introduced.
-- The DEFINER switch here runs in the opposite direction from CP5's and
-- CP7's public bridges: those exist because their caller (`authenticated`)
-- has too little privilege to reach `private` at all. These exist because
-- their caller (`postgres`, via cron) has too much -- BYPASSRLS, full table
-- grants, schema ownership -- and DEFINER is what narrows a whole-schema-
-- capable caller down to exactly finance_snapshot_writer's own, already-
-- audited, RLS-bound reach. Once inside, FORCE ROW LEVEL SECURITY applies to
-- finance_snapshot_writer exactly as it does everywhere else, because the
-- role is NOBYPASSRLS and stays that way -- unchanged, unasserted-away, by
-- this migration.
--
-- Both functions live in `private`, not `public`: nothing here is meant to
-- be PostgREST-reachable, and `private` already carries zero API exposure
-- and zero USAGE for `anon`/`authenticated` (Phase 4, reasserted in every
-- privilege test since). EXECUTE is revoked from `public`, `anon`, and
-- `authenticated` explicitly below, on top of that structural fact, in the
-- same belt-and-suspenders style every other sensitive function in this
-- schema already uses. `postgres` needs no explicit EXECUTE grant to call
-- either one: it is a member of `finance_snapshot_writer` with INHERIT
-- (established in migration 7, reused here rather than widened), which is
-- what already lets it manage writer-owned objects across every migration
-- since, and functions always carry an implicit EXECUTE for their owner.
--
-- ============================================================
-- Enumerating every owner without touching CP5's narrow profiles policy
-- ============================================================
--
-- CP5 gave finance_snapshot_writer exactly one profiles privilege --
-- `select (id, timezone)`, behind `profiles_select_writer`, scoped to
-- `id = private.request_owner_id()` -- and 090-privileges.sql pins the
-- claimless case directly: "writer sees zero profiles when the session
-- carries no JWT claim." A cron job carries no JWT claim. Widening that
-- policy to see every owner would make it pass for the wrong reason and
-- silently invalidate the exact guarantee that test exists to protect --
-- and CP8A does not weaken CP5's bridge to make unattended maintenance
-- easier.
--
-- So neither function below reads `profiles` broadly. Both discover which
-- owners to consider from a table finance_snapshot_writer already has
-- unconditional `using (true)` SELECT on since Phase 4 (`bills` for the
-- schedule job, `accounts` for the snapshot job -- an owner with a
-- net-worth-relevant footprint has at least one account), then, for each
-- owner in turn, call `set_config('request.jwt.claim.sub', <that owner's
-- id>, true)` before touching `profiles` -- the transaction-scoped
-- equivalent of `SET LOCAL`, and the exact mechanism
-- `private.request_owner_id()` already reads and 090-privileges.sql already
-- drives by hand (`set local request.jwt.claim.sub = ...`) to exercise this
-- same policy. `profiles_select_writer` therefore sees exactly the one
-- profile each loop iteration impersonates, one at a time, through the
-- unmodified policy CP5 shipped -- never all of them at once.
create extension if not exists pg_cron;

-- ============================================================
-- private.maintain_all_active_bill_schedules -- daily bill-horizon top-up
-- ============================================================
-- The non-destructive half of CP7's own `maintain_bill_schedule`: for every
-- non-archived bill, top the horizon up to one year from that bill's owner's
-- own today (or the bill's anchor, if further out) -- the identical
-- `greatest(today + 1 year, anchor)` rule CP7 already uses, applied here to
-- every bill rather than to one bill a request named.
--
-- `p_rebuild_future` is never true here. A daily maintenance pass is not a
-- terms change, and must never delete a scheduled row -- only
-- `replace_bill`, on an actual amount/frequency/anchor edit, does that.
-- Every insert below goes through `private.generate_bill_occurrences_for_bill`
-- unmodified, `on conflict (bill_id, due_date) do nothing`, so a paid,
-- skipped, or already-scheduled occurrence is untouched by construction --
-- the same reasoning CP7 already documents for that function, reused here
-- rather than re-derived.
--
-- Each bill runs inside its own nested block. A single pathological bill
-- (the iteration-cap guard in generate_bill_occurrences_for_bill) is
-- recorded and skipped rather than aborting every other owner's maintenance
-- for the day -- the same "one owner's failure does not block another"
-- requirement the snapshot function below satisfies for the same reason.
--
-- Returns a small summary rather than void, so a manual invocation (or
-- pg_cron's own `cron.job_run_details.return_message`) can show what
-- happened without any table this role can be granted to log into.
create function private.maintain_all_active_bill_schedules()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_horizon constant interval := interval '1 year';
  v_bill record;
  v_timezone text;
  v_today date;
  v_had_any_occurrence boolean;
  v_from_date date;
  v_horizon_date date;
  v_considered integer := 0;
  v_topped_up integer := 0;
  v_skipped integer := 0;
begin
  for v_bill in
    select b.id, b.user_id, b.anchor_date
    from public.bills b
    where b.is_archived = false
  loop
    v_considered := v_considered + 1;

    begin
      perform set_config('request.jwt.claim.sub', v_bill.user_id::text, true);

      select p.timezone into v_timezone
      from public.profiles p
      where p.id = v_bill.user_id;

      -- No profile visible for this owner (mis-provisioned data, never a
      -- real owner) -- skip rather than guess a timezone.
      if v_timezone is null then
        v_skipped := v_skipped + 1;
      else
        v_today := (now() at time zone v_timezone)::date;

        select exists (
          select 1
          from public.bill_occurrences o
          where o.bill_id = v_bill.id and o.user_id = v_bill.user_id
        ) into v_had_any_occurrence;

        v_from_date := case when v_had_any_occurrence then v_today else v_bill.anchor_date end;
        v_horizon_date := greatest((v_today + c_horizon)::date, v_bill.anchor_date);

        perform private.generate_bill_occurrences_for_bill(
          v_bill.id, v_bill.user_id, v_from_date, v_horizon_date
        );

        v_topped_up := v_topped_up + 1;
      end if;
    exception when others then
      -- A pathological single bill (or any other unexpected failure) must
      -- not stop every other owner's maintenance for the day. No amount, no
      -- owner id -- only a classification, mirroring
      -- lib/data/mutations/snapshots.ts's own "sanitized noun plus code"
      -- rule for what unattended failures may record.
      v_skipped := v_skipped + 1;
      raise warning 'bill schedule maintenance: skipped one bill (sqlstate %)', sqlstate;
    end;
  end loop;

  perform set_config('request.jwt.claim.sub', '', true);

  return jsonb_build_object(
    'bills_considered', v_considered,
    'bills_topped_up', v_topped_up,
    'bills_skipped', v_skipped
  );
end;
$$;

alter function private.maintain_all_active_bill_schedules() owner to finance_snapshot_writer;

revoke execute on function private.maintain_all_active_bill_schedules()
  from public, anon, authenticated;

-- ============================================================
-- private.refresh_all_current_net_worth_snapshots -- daily snapshot upkeep
-- ============================================================
-- The system-wide counterpart to CP5's `public.refresh_current_net_worth_snapshot`:
-- for every owner (discovered via `accounts`, per the note above), take that
-- owner's own current month and call the unmodified Phase 4 writer,
-- `private.write_net_worth_snapshot`. No arithmetic is repeated here -- this
-- is a loop and an owner-timezone month calculation around a function that
-- already does the actual computation and is already idempotent via its own
-- `ON CONFLICT (user_id, month) DO UPDATE`. Calling it twice for the same
-- owner and month, whether from a request or from this job, produces the
-- same row.
--
-- Each owner runs inside its own nested block, exactly as the bill function
-- above. A `data_exception` (SQLSTATE 22000) is CP5's own documented sign-
-- guard outcome -- raised *before* any write, so the owner's existing
-- snapshot row is left byte for byte unchanged, exactly as it already is
-- when the outcome is reached through a request. It is counted and the loop
-- moves on to the next owner; nothing about it is treated as more severe
-- than the condition already is at the request layer. Any other error is
-- caught the same way, so one owner's failure -- of any kind -- never
-- prevents another owner's maintenance from being attempted.
--
-- No figure and no owner id is ever raised, matching the same rule the bill
-- function above follows and `lib/data/mutations/snapshots.ts` already states
-- for the request-driven path.
create function private.refresh_all_current_net_worth_snapshots()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_timezone text;
  v_month text;
  v_considered integer := 0;
  v_refreshed integer := 0;
  v_skipped_sign_guard integer := 0;
  v_skipped_other integer := 0;
begin
  for v_owner_id in
    select distinct a.user_id
    from public.accounts a
  loop
    v_considered := v_considered + 1;

    begin
      perform set_config('request.jwt.claim.sub', v_owner_id::text, true);

      select p.timezone into v_timezone
      from public.profiles p
      where p.id = v_owner_id;

      if v_timezone is null then
        v_skipped_other := v_skipped_other + 1;
      else
        v_month := to_char((now() at time zone v_timezone)::date, 'YYYY-MM');

        perform private.write_net_worth_snapshot(v_owner_id, v_month);

        v_refreshed := v_refreshed + 1;
      end if;
    exception
      when sqlstate '22000' then
        -- The documented sign-guard outcome. The prior snapshot row is
        -- already untouched -- write_net_worth_snapshot raised before its
        -- own INSERT/UPDATE -- and the primary ledger this owner's balances
        -- live in was never part of this transaction at all.
        v_skipped_sign_guard := v_skipped_sign_guard + 1;
      when others then
        v_skipped_other := v_skipped_other + 1;
        raise warning 'current snapshot maintenance: skipped one owner (sqlstate %)', sqlstate;
    end;
  end loop;

  perform set_config('request.jwt.claim.sub', '', true);

  return jsonb_build_object(
    'owners_considered', v_considered,
    'owners_refreshed', v_refreshed,
    'owners_skipped_sign_guard', v_skipped_sign_guard,
    'owners_skipped_other', v_skipped_other
  );
end;
$$;

alter function private.refresh_all_current_net_worth_snapshots() owner to finance_snapshot_writer;

revoke execute on function private.refresh_all_current_net_worth_snapshots()
  from public, anon, authenticated;

-- ============================================================
-- The two daily jobs
-- ============================================================
-- `cron.schedule` upserts by job name, so re-running this migration (a local
-- `db reset`) leaves exactly one job per name rather than accumulating
-- duplicates. Both run once a day -- cheap, idempotent, and (per the CP8A
-- brief) preferable to chasing an exact month-boundary trigger for a
-- maintenance pass that is safe to repeat. Times are arbitrary off-peak UTC
-- slots, five minutes apart so the two passes do not overlap.
--
-- Neither schedule, nor either command string, takes a parameter of any
-- kind -- there is nothing here for a caller to have addressed even if a
-- caller other than pg_cron itself could reach these names, which none can.
select cron.schedule(
  'bill-schedule-maintenance',
  '17 3 * * *',
  $$ select private.maintain_all_active_bill_schedules(); $$
);

select cron.schedule(
  'current-snapshot-maintenance',
  '22 3 * * *',
  $$ select private.refresh_all_current_net_worth_snapshots(); $$
);
