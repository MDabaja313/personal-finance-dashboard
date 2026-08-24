-- Phase 4, migration 7: bill recurrence.
--
-- Creates the finance_snapshot_writer system role (Option B, approved at
-- Gate 3) and the two recurrence functions:
--   private.next_bill_occurrence_date — pure date arithmetic, INVOKER
--   private.generate_bill_occurrences — SECURITY DEFINER, owned by the
--     writer role
--
-- No cron.schedule() call — Phase 4 settles and proves the privilege
-- model; scheduling is out of scope.

-- ============================================================
-- finance_snapshot_writer — dedicated NOLOGIN system role
-- ============================================================
-- Narrowly privileged object-owning role. Explicitly NOT superuser, not
-- BYPASSRLS, no login, no create-db/create-role/replication. It does not
-- bypass RLS — every relation it needs is granted object privileges and
-- a matching role-targeted policy individually (migration 8 continues
-- this for net_worth_snapshots). No application role (anon,
-- authenticated) is, or ever becomes, a member of it, so nothing but
-- the SECURITY DEFINER functions that assume its identity can reach the
-- privileges granted to it.

create role finance_snapshot_writer with
  nologin
  nosuperuser
  nocreatedb
  nocreaterole
  nobypassrls
  noreplication;

-- postgres (the migration/reset role) is made a MEMBER of
-- finance_snapshot_writer so it can manage (ALTER FUNCTION ... OWNER
-- TO, etc.) objects owned by that role in this and future migrations.
-- Membership grants the ability to SET ROLE / act as the role and to
-- administer its owned objects — it does NOT give finance_snapshot_writer
-- postgres's own BYPASSRLS attribute (postgres itself is NOSUPERUSER
-- here; BYPASSRLS is the attribute it actually holds), and it does not
-- change what finance_snapshot_writer itself can do when a SECURITY
-- DEFINER function runs as it.
grant finance_snapshot_writer to postgres;

-- ALTER FUNCTION ... OWNER TO requires the new owner to hold CREATE on
-- the containing schema (a standard PostgreSQL requirement — an owner
-- must be able to have created the kind of object it owns). private
-- has no CREATE for anyone but postgres by default (it was never
-- granted broadly); this grants it narrowly to the one role that will
-- own the three SECURITY DEFINER functions living there.
grant create on schema private to finance_snapshot_writer;

-- USAGE is required separately — owning objects in a schema does not
-- itself grant the ability to reference other objects in that schema
-- by qualified name at call time. Without this,
-- generate_bill_occurrences (running as finance_snapshot_writer via
-- SECURITY DEFINER) cannot call private.next_bill_occurrence_date at
-- all, even though EXECUTE on that function was never revoked from
-- finance_snapshot_writer — confirmed by reproducing "permission denied
-- for schema private" without this grant.
grant usage on schema private to finance_snapshot_writer;

-- ============================================================
-- next_bill_occurrence_date — pure, no table access, SECURITY INVOKER
-- ============================================================
-- Every rule derives from the ORIGINAL anchor_date, never from a
-- previously-clamped occurrence — a Jan-31 anchor yields
-- Feb 28 -> Mar 31 -> Apr 30 -> May 31, not Mar 28 (see the doc's
-- worked example). `after` is the last known/generated due date (or the
-- anchor itself, for the first occurrence); the function returns the
-- next due date strictly after it.

create function private.next_bill_occurrence_date(
  p_anchor_date date,
  p_frequency public.bill_frequency,
  p_after date
)
returns date
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_anchor_day integer;
  v_target_year integer;
  v_target_month integer;
  v_months_from_anchor integer;
  v_candidate date;
  v_days_in_target_month integer;
begin
  if p_frequency = 'weekly' then
    return p_anchor_date + (((p_after - p_anchor_date) / 7 + 1) * 7);
  end if;

  if p_frequency = 'biweekly' then
    return p_anchor_date + (((p_after - p_anchor_date) / 14 + 1) * 14);
  end if;

  if p_frequency = 'monthly' then
    v_anchor_day := extract(day from p_anchor_date)::integer;
    -- Advance whole months from the ORIGINAL anchor's year/month, then
    -- clamp the anchor's day-of-month independently against each
    -- candidate target month's length — never against a prior result.
    v_months_from_anchor := (extract(year from p_after) - extract(year from p_anchor_date)) * 12
      + (extract(month from p_after) - extract(month from p_anchor_date));
    loop
      v_months_from_anchor := v_months_from_anchor + 1;
      v_target_year := extract(year from p_anchor_date)::integer
        + (extract(month from p_anchor_date)::integer - 1 + v_months_from_anchor) / 12;
      v_target_month := (extract(month from p_anchor_date)::integer - 1 + v_months_from_anchor) % 12 + 1;
      v_days_in_target_month := extract(
        day from (make_date(v_target_year, v_target_month, 1) + interval '1 month - 1 day')
      )::integer;
      v_candidate := make_date(v_target_year, v_target_month, least(v_anchor_day, v_days_in_target_month));
      exit when v_candidate > p_after;
    end loop;
    return v_candidate;
  end if;

  if p_frequency = 'yearly' then
    -- Preserve the original month/day; Feb 29 clamps to Feb 28 in a
    -- non-leap year and returns to Feb 29 the next time the year is a
    -- leap year — each year clamped independently from the anchor.
    v_target_year := extract(year from p_after)::integer;
    loop
      v_target_year := v_target_year + 1;
      begin
        v_candidate := make_date(
          v_target_year,
          extract(month from p_anchor_date)::integer,
          extract(day from p_anchor_date)::integer
        );
      exception when others then
        -- Feb 29 in a non-leap target year.
        v_candidate := make_date(v_target_year, 2, 28);
      end;
      exit when v_candidate > p_after;
    end loop;
    return v_candidate;
  end if;

  raise exception 'unrecognized bill frequency';
end;
$$;

revoke execute on function private.next_bill_occurrence_date(date, public.bill_frequency, date)
  from public, anon, authenticated;

-- generate_bill_occurrences (SECURITY DEFINER, owned by
-- finance_snapshot_writer, below) calls this function. The global
-- default-privilege revoke in migration 1 means nothing gets implicit
-- EXECUTE any more — finance_snapshot_writer needs it granted
-- explicitly, same as any other caller would.
grant execute on function private.next_bill_occurrence_date(date, public.bill_frequency, date)
  to finance_snapshot_writer;

-- ============================================================
-- generate_bill_occurrences — SECURITY DEFINER, owned by the writer
-- ============================================================
-- Generates `scheduled` occurrences forward through a rolling horizon
-- for one user's non-archived bills, idempotent via
-- UNIQUE (bill_id, due_date) — a duplicate insert is skipped, not
-- overwritten. Never touches an existing row: paid/skipped historical
-- amounts are never rewritten, and no existing scheduled row is
-- updated either — ON CONFLICT DO NOTHING. Copies bills.amount_cents
-- into bill_occurrences.amount_cents at INSERT time only.

create function private.generate_bill_occurrences(
  p_user_id uuid,
  p_horizon_date date
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bill record;
  v_last_due date;
  v_next_due date;
  v_inserted integer := 0;
begin
  for v_bill in
    select id, amount_cents, frequency, anchor_date
    from public.bills
    where user_id = p_user_id and is_archived = false
  loop
    select max(due_date) into v_last_due
    from public.bill_occurrences
    where bill_id = v_bill.id and user_id = p_user_id;

    if v_last_due is null then
      -- No occurrence generated yet: the anchor date itself is the
      -- first due date, if it does not already exist.
      v_next_due := v_bill.anchor_date;
    else
      v_next_due := private.next_bill_occurrence_date(v_bill.anchor_date, v_bill.frequency, v_last_due);
    end if;

    while v_next_due <= p_horizon_date loop
      insert into public.bill_occurrences (user_id, bill_id, due_date, status, amount_cents)
      values (p_user_id, v_bill.id, v_next_due, 'scheduled', v_bill.amount_cents)
      on conflict (bill_id, due_date) do nothing;

      if found then
        v_inserted := v_inserted + 1;
      end if;

      v_next_due := private.next_bill_occurrence_date(v_bill.anchor_date, v_bill.frequency, v_next_due);
    end loop;
  end loop;

  return v_inserted;
end;
$$;

alter function private.generate_bill_occurrences(uuid, date) owner to finance_snapshot_writer;

revoke execute on function private.generate_bill_occurrences(uuid, date)
  from public, anon, authenticated;

-- ============================================================
-- Object privileges + RLS policies for finance_snapshot_writer
-- ============================================================
-- finance_snapshot_writer does NOT bypass RLS (nobypassrls above) and
-- FORCE ROW LEVEL SECURITY remains enabled on every table it touches —
-- both an object privilege AND a role-targeted policy are required per
-- relation. Grants are limited to exactly what generate_bill_occurrences
-- needs: SELECT on bills, SELECT+INSERT on bill_occurrences. No DELETE.
-- No access to categories, movements, budgets, goals,
-- goal_contributions, or profiles — the function takes p_user_id
-- explicitly and never enumerates profiles.

grant select on table public.bills to finance_snapshot_writer;
grant select, insert on table public.bill_occurrences to finance_snapshot_writer;

-- The broad `USING (true)` / `WITH CHECK (true)` predicates below are
-- acceptable only because finance_snapshot_writer is NOLOGIN (no
-- application session can ever authenticate as it or SET ROLE to it —
-- authenticated/anon are not members of it), and its only real callers
-- are the SECURITY DEFINER functions above, which scope every operation
-- to the explicit p_user_id parameter they receive.

create policy bills_select_writer on public.bills
  for select to finance_snapshot_writer
  using (true);

create policy bill_occurrences_select_writer on public.bill_occurrences
  for select to finance_snapshot_writer
  using (true);

create policy bill_occurrences_insert_writer on public.bill_occurrences
  for insert to finance_snapshot_writer
  with check (true);
