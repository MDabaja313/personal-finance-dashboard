-- Phase 7 Checkpoint 5, migration M14: the current-month snapshot bridge.
--
-- One narrow, zero-parameter public entry point --
-- `public.refresh_current_net_worth_snapshot()` -- over the Phase 4
-- private snapshot writer, plus the two privileges it needs to resolve
-- which month "current" means. No Phase 4 migration is edited, the
-- private writers are untouched, and `authenticated` gains no access to
-- the `private` schema.
--
-- ============================================================
-- What this deliberately is NOT
-- ============================================================
--
-- It is not a snapshot API. It takes no user and no month, so a caller
-- can address neither another owner nor another month -- not because a
-- check rejects those arguments, but because there are no arguments.
-- `private.write_net_worth_snapshots_for_range` stays exactly where it
-- was: unreachable by `authenticated`, with no public wrapper of any
-- kind. Historical rebuild remains an operator action, and CP5
-- explicitly accepts the historical limitations that follow from that
-- (no `opened_on`, no archived-at reconstruction, no prior-month repair
-- after a backdated edit). Live derived balances are authoritative; the
-- snapshot series is a secondary trend.
--
-- ============================================================
-- Why SECURITY DEFINER here, when nothing else in CP2-CP5 needs it
-- ============================================================
--
-- Every other function this phase added is SECURITY INVOKER, because
-- the caller already held every privilege the body used. This one is
-- the exception, and the reason is a hard boundary rather than a
-- preference: `private.write_net_worth_snapshot` is owned by
-- finance_snapshot_writer, `authenticated` has no USAGE on the `private`
-- schema at all (090-privileges.sql asserts it, and CP4 depends on that
-- staying true), and net_worth_snapshots has no INSERT or UPDATE grant
-- for `authenticated` and never will. A SECURITY INVOKER wrapper could
-- therefore reach nothing it needs.
--
-- So the bridge takes the writer's identity, and is kept as narrow as a
-- bridge can be:
--
--   * Owner is the existing finance_snapshot_writer role -- NOLOGIN,
--     NOSUPERUSER, NOBYPASSRLS, no application role is a member. It is
--     not postgres, whose BYPASSRLS attribute would make a
--     browser-reachable function into an RLS bypass.
--   * `set search_path = ''` with every name schema-qualified.
--   * Zero parameters.
--   * The owner is read from the request's own JWT claim and is never
--     supplied.
--   * EXECUTE revoked from PUBLIC and anon, granted to authenticated
--     alone.
--   * The privileges the writer gains are one column-scoped SELECT on
--     profiles and one RLS policy narrowed to the calling JWT's own
--     row. It gains nothing else: no INSERT/UPDATE/DELETE on profiles,
--     no access to categories, movements, budgets, goals or
--     goal_contributions, and no change to what it already held on
--     accounts, transactions and net_worth_snapshots.
--
-- ============================================================
-- Why the caller's uid is read from the GUC rather than from auth.uid()
-- ============================================================
--
-- Inside a SECURITY DEFINER body the current role is the *owner*, so
-- every function the body calls is called as finance_snapshot_writer --
-- including auth.uid(). And finance_snapshot_writer has no USAGE on
-- schema `auth`:
--
--     set role finance_snapshot_writer; select auth.uid();
--     ERROR:  permission denied for schema auth
--
-- That cannot simply be granted from a migration, either. Schema `auth`
-- is owned by supabase_auth_admin, and the migration role does not hold
-- USAGE on it WITH GRANT OPTION, so `grant usage on schema auth to
-- finance_snapshot_writer` reports "WARNING: no privileges were granted
-- for auth" and changes nothing. Both facts were verified directly
-- against the local Postgres 17.6 image rather than assumed.
--
-- The claim itself is not privileged -- it is a GUC, readable through
-- pg_catalog by any role -- so `private.request_owner_id()` below reads
-- it exactly as auth.uid() does. That duplication is deliberate and is
-- pinned by a test rather than left to drift: 160-current-snapshot.sql
-- asserts `private.request_owner_id()` equals `auth.uid()` for a set
-- claim, for a claimless session, and for a malformed one.

-- ============================================================
-- private.request_owner_id -- the JWT `sub`, without the auth schema
-- ============================================================
-- SECURITY INVOKER and STABLE: it reads two GUCs and nothing else, so it
-- has the caller's privileges (which is to say: it needs none) and is
-- constant within a statement.
--
-- `current_setting(..., true)` -- the missing_ok form -- in both places,
-- so a session with no claim set returns NULL rather than raising. That
-- is the same shape auth.uid() takes, and it is what lets the wrapper
-- below turn "no caller" into its own explicit refusal.
--
-- Lives in `private`, so it is unreachable by `authenticated` and by
-- `anon` at the schema level regardless of any function-level grant.
-- finance_snapshot_writer gets EXECUTE explicitly, exactly as
-- private.next_bill_occurrence_date does (migration 7): the global
-- default-privileges posture from migration 1 means a newly created
-- function grants EXECUTE to nobody but its creator.

create function private.request_owner_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

revoke execute on function private.request_owner_id() from public, anon, authenticated;

grant execute on function private.request_owner_id() to finance_snapshot_writer;

-- ============================================================
-- The writer's profile read: one column-scoped SELECT, one narrow policy
-- ============================================================
-- The only thing the bridge needs from profiles is the caller's
-- timezone, so the grant names exactly the column it reads and the
-- column it filters on. `created_at`/`updated_at` are not granted, and
-- there is no INSERT, UPDATE or DELETE grant of any kind.
--
-- The policy is narrower than the writer's existing ones on accounts,
-- transactions and net_worth_snapshots -- those are `using (true)`,
-- justified by the role being NOLOGIN with no members and every caller
-- scoping to an explicit p_user_id. Here a genuinely tighter predicate
-- is available for free, because the request's own claim is readable
-- without the auth schema: the writer can see the calling JWT's profile
-- row and no other, in any session, whatever the function body asks
-- for. A session with no claim (a cron job, a psql shell) sees zero
-- profile rows, which is the correct answer for a bridge that only ever
-- acts on behalf of a live request.
--
-- Phase 4's own private writers are unaffected: neither of them reads
-- profiles at all -- both take p_user_id explicitly and never enumerate
-- owners -- so this policy adds a capability rather than changing one.

grant select (id, timezone) on table public.profiles to finance_snapshot_writer;

create policy profiles_select_writer on public.profiles
  for select to finance_snapshot_writer
  using (id = private.request_owner_id());

-- ============================================================
-- public.refresh_current_net_worth_snapshot -- the bridge
-- ============================================================
-- Derive the owner, read that owner's timezone, take the calendar month
-- that owner is currently in, and hand both to the existing Phase 4
-- writer. Every one of those steps is fixed; none is a parameter.
--
-- THE MONTH COMES FROM THE OWNER'S PROFILE TIMEZONE, NEVER FROM SERVER
-- UTC. `(now() at time zone <the owner's zone>)::date` is the same
-- expression assert_transaction_refs() uses for its posted-date ceiling
-- and the same calendar day lib/data/clock.ts derives for getToday(), so
-- the month a snapshot is written for is the month the person is
-- actually in. For an owner in Auckland a UTC month key would be the
-- *previous* month for the first thirteen hours of every 1st; for an
-- owner in Los Angeles it would be the *next* month for the last seven
-- hours of every month-end. 160-current-snapshot.sql pins both
-- directions with a profile whose local month differs from UTC's at the
-- instant the test runs.
--
-- The write itself is untouched Phase 4 behavior: as-of that month's
-- last calendar day, archived accounts excluded, credit/loan classified
-- as liabilities, upserted on (user_id, month). Calling this twice in a
-- row therefore produces the same row, and calling it after any
-- balance-affecting write brings that row up to date -- which is the
-- whole contract lib/data/mutations/snapshots.ts relies on.
--
-- A profile that does not exist is a provisioning failure, not a
-- no-op: `getToday()` treats the same case as `data_integrity`, and a
-- snapshot silently not written is exactly the failure mode a trend
-- chart cannot show.
--
-- Error text names no owner id, no month, and no figure of any kind.

create function public.refresh_current_net_worth_snapshot()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := private.request_owner_id();
  v_timezone text;
  v_month text;
begin
  if v_owner_id is null then
    raise exception 'refresh_current_net_worth_snapshot requires an authenticated caller'
      using errcode = 'invalid_authorization_specification';
  end if;

  -- Scoped explicitly to the derived owner as well as by the policy
  -- above, per the same defense-in-depth rule every other lookup in this
  -- schema follows.
  select p.timezone into v_timezone
  from public.profiles p
  where p.id = v_owner_id;

  if v_timezone is null then
    raise exception 'refresh_current_net_worth_snapshot: the caller has no profile'
      using errcode = 'no_data_found';
  end if;

  v_month := to_char((now() at time zone v_timezone)::date, 'YYYY-MM');

  perform private.write_net_worth_snapshot(v_owner_id, v_month);
end;
$$;

-- ALTER FUNCTION ... OWNER TO requires the incoming owner to hold CREATE
-- on the containing schema -- PostgreSQL's rule that an owner must be
-- able to have created the kind of object it owns. finance_snapshot_writer
-- holds CREATE on `private` (migration 7) and deliberately holds none on
-- `public`, so the privilege is granted for exactly this statement and
-- taken straight back. The ownership it establishes is permanent; the
-- privilege is not, and 090-privileges.sql asserts the role ends up with
-- no CREATE on public.
grant create on schema public to finance_snapshot_writer;

alter function public.refresh_current_net_worth_snapshot()
  owner to finance_snapshot_writer;

revoke create on schema public from finance_snapshot_writer;

revoke execute on function public.refresh_current_net_worth_snapshot()
  from public, anon;

grant execute on function public.refresh_current_net_worth_snapshot()
  to authenticated;
