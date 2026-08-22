-- Phase 4, migration 4: functions and triggers.
--
-- Four functions only — validate_profile_timezone, validate_movement,
-- guard_bill_occurrence_delete, set_updated_at. All SECURITY INVOKER
-- (the default; prosecdef = false), each individually justified in
-- docs/rls-policies.md §11 rather than assumed. No function is granted
-- EXECUTE to anon or authenticated — migration 1 already revoked the
-- PUBLIC default for every function created from here on; this
-- migration adds the same revoke explicitly per function, belt-and-
-- braces rather than relying on the default-privileges posture alone.

-- ============================================================
-- set_updated_at — profiles.updated_at only
-- ============================================================
-- No other table in this schema declares updated_at (docs/database-
-- schema.md §4 lists it only on profiles) — this trigger is not
-- generalized to tables that don't have the column.

create function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.set_updated_at() from public, anon, authenticated;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

-- ============================================================
-- validate_profile_timezone — BEFORE INSERT OR UPDATE on profiles
-- ============================================================
-- Validates against PostgreSQL's own pg_timezone_names catalog, not a
-- regex (which can only confirm a string looks like Area/City, not that
-- the zone exists) and not a CHECK constraint (pg_timezone_names is a
-- mutable catalog lookup, not an immutable per-row expression).
-- SECURITY INVOKER: pg_timezone_names is world-readable, so no elevated
-- context is needed for this check to work for any caller.

create function public.validate_profile_timezone()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from pg_catalog.pg_timezone_names where name = new.timezone
  ) then
    raise exception 'invalid timezone: %', new.timezone
      using errcode = 'invalid_parameter_value';
  end if;
  return new;
end;
$$;

revoke execute on function public.validate_profile_timezone() from public, anon, authenticated;

create trigger profiles_validate_timezone
  before insert or update on public.profiles
  for each row
  execute function public.validate_profile_timezone();

-- ============================================================
-- validate_movement — deferred cross-row invariant for movement legs
-- ============================================================
-- SECURITY INVOKER: under FORCE RLS the invoker sees only its own rows,
-- which is correct — the invariant is per-user, and the composite FK
-- (transactions.movement_id, user_id) -> movements(id, user_id) already
-- guarantees same-user legs structurally.
--
-- Fires AFTER INSERT OR UPDATE OR DELETE on transactions, and AFTER
-- INSERT OR UPDATE on movements (the latter is what makes a zero-leg
-- orphan movement fail). DEFERRABLE INITIALLY DEFERRED: the two legs of
-- one movement are inserted as two separate statements inside one
-- transaction, so a non-deferred trigger would fail validating the
-- first leg before the second exists.
--
-- Per affected movement_id, the parent-existence check runs first: if
-- the movement no longer exists, validation is skipped for that id —
-- this is what distinguishes the legitimate "delete the parent, cascade
-- both legs" case from an illegitimate direct leg deletion, where the
-- parent is still present and the leg-count check still fires.
--
-- Error text names only the movement id and the violated rule — never
-- an amount, merchant, or account name.

create function public.validate_movement()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_movement_id uuid;
  v_movement_ids uuid[];
  v_movement public.movements%rowtype;
  v_leg_count integer;
  v_leg_sum bigint;
  v_kind_count integer;
  v_account_count integer;
  v_user_count integer;
  v_matching_kind_count integer;
begin
  -- Collect every movement_id touched by this DML event.
  if tg_table_name = 'movements' then
    v_movement_ids := array[new.id];
  else
    -- transactions: INSERT/DELETE touch one id; UPDATE must check both
    -- OLD.movement_id and NEW.movement_id when they differ — re-
    -- parenting a leg invalidates the movement it left as well as the
    -- one it joined.
    if tg_op = 'DELETE' then
      v_movement_ids := array[old.movement_id];
    elsif tg_op = 'INSERT' then
      v_movement_ids := array[new.movement_id];
    else
      if new.movement_id is distinct from old.movement_id then
        v_movement_ids := array[old.movement_id, new.movement_id];
      else
        v_movement_ids := array[new.movement_id];
      end if;
    end if;
  end if;

  foreach v_movement_id in array v_movement_ids loop
    if v_movement_id is null then
      continue;
    end if;

    select * into v_movement from public.movements where id = v_movement_id;

    -- Parent no longer exists: the cascade already removed both legs.
    -- This is intentional and must not be rejected.
    if not found then
      continue;
    end if;

    select
      count(*),
      coalesce(sum(amount_cents), 0),
      count(distinct kind),
      count(distinct account_id),
      count(distinct user_id),
      count(*) filter (where kind::text = v_movement.kind::text)
    into
      v_leg_count, v_leg_sum, v_kind_count, v_account_count, v_user_count,
      v_matching_kind_count
    from public.transactions
    where movement_id = v_movement_id;

    if v_leg_count <> 2 then
      raise exception 'movement % is invalid: expected exactly two legs, found %',
        v_movement_id, v_leg_count
        using errcode = 'check_violation';
    end if;

    if v_leg_sum <> 0 then
      raise exception 'movement % is invalid: legs do not sum to zero', v_movement_id
        using errcode = 'check_violation';
    end if;

    if v_matching_kind_count <> 2 then
      raise exception 'movement % is invalid: a leg kind does not match the movement kind',
        v_movement_id
        using errcode = 'check_violation';
    end if;

    if v_account_count <> 2 then
      raise exception 'movement % is invalid: legs must reference two different accounts',
        v_movement_id
        using errcode = 'check_violation';
    end if;

    if v_user_count <> 1 or (
      select count(*) from public.transactions
      where movement_id = v_movement_id and user_id <> v_movement.user_id
    ) > 0 then
      raise exception 'movement % is invalid: ownership mismatch between movement and legs',
        v_movement_id
        using errcode = 'check_violation';
    end if;
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function public.validate_movement() from public, anon, authenticated;

create constraint trigger transactions_validate_movement
  after insert or update or delete on public.transactions
  deferrable initially deferred
  for each row
  execute function public.validate_movement();

create constraint trigger movements_validate_movement
  after insert or update on public.movements
  deferrable initially deferred
  for each row
  execute function public.validate_movement();

-- ============================================================
-- guard_bill_occurrence_delete — BEFORE DELETE on bill_occurrences
-- ============================================================
-- scheduled -> allowed. paid/skipped -> rejected, UNLESS the owning
-- profiles row no longer exists — which is the case exactly when this
-- delete is happening as part of an ON DELETE CASCADE teardown
-- originating from profiles (auth.users deletion). Cascade actions from
-- a foreign key are performed as ordinary SQL delete commands on each
-- referencing table, fired as trigger events on that table — so by the
-- time this DELETE runs as part of the profiles cascade, the profiles
-- row is already gone and invisible to this statement's snapshot. A
-- direct delete while the owning profile still exists still finds the
-- row and is rejected.
--
-- authenticated holds no DELETE grant on this table under any
-- circumstance through Phase 6 regardless — this trigger is defense-in-
-- depth against a privileged or direct-SQL deletion path.
--
-- Scope, stated explicitly: this is a row-level BEFORE DELETE trigger,
-- so it does not fire on TRUNCATE. bills does NOT cascade to
-- bill_occurrences — bills are soft-deleted (is_archived) and
-- occurrences are retained regardless.

create function public.guard_bill_occurrence_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status in ('paid', 'skipped')
     and exists (select 1 from public.profiles where id = old.user_id)
  then
    raise exception 'bill occurrence % cannot be deleted: status is %', old.id, old.status
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

revoke execute on function public.guard_bill_occurrence_delete() from public, anon, authenticated;

create trigger bill_occurrences_guard_delete
  before delete on public.bill_occurrences
  for each row
  execute function public.guard_bill_occurrence_delete();
