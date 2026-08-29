-- Phase 7 Checkpoint 7: recurring-bill and bill-occurrence writes.
--
-- Two relations move off the Phase 4 read-only posture: `bills` (column-scoped
-- INSERT and UPDATE, never DELETE) and `bill_occurrences` (a three-column
-- UPDATE and nothing else -- no INSERT, no DELETE, for `authenticated`, ever).
-- No earlier migration is edited, and no privilege CP2-CP6 already granted is
-- touched.
--
-- `anon` is not named in a single GRANT or policy below.
--
-- ============================================================
-- The shape of this checkpoint, and why it is not the CP6 shape
-- ============================================================
--
-- Budgets and goals were ordinary tables: a form posts a row, PostgREST writes
-- it, done. A recurring bill is not one row. It is a parent plus a *derived
-- rolling schedule* of concrete occurrences, and the two have to move
-- together:
--
--   * Creating a bill with no occurrences produces a bill that `getBills()`
--     cannot project a due date for -- it is invisible on /bills and on the
--     dashboard, which is indistinguishable from the create having failed.
--   * Editing a bill's amount, frequency or anchor date invalidates every
--     *future* scheduled occurrence and no past one. If the rebuild is a
--     second request and it fails, the stored bill says one thing and its
--     schedule says another, permanently, with nothing to notice it.
--
-- So bill create/edit/archive are three SECURITY INVOKER RPCs -- the CP4
-- posture, for the CP4 reason: the caller already holds every privilege the
-- bodies use, and the operation is only correct if it is one transaction.
--
-- ============================================================
-- Why one SECURITY DEFINER bridge, and how narrow it is
-- ============================================================
--
-- Generating and rebuilding occurrences cannot be done by `authenticated`,
-- and that is deliberate rather than incidental:
--
--   * `authenticated` gets no INSERT on bill_occurrences. An occurrence is a
--     system-derived fact ("this obligation falls due on this date for this
--     amount"), not something a person types. A direct INSERT grant would let
--     a hand-crafted request invent an occurrence on any date, for any amount,
--     for a bill whose terms say otherwise -- and the amount is precisely the
--     value docs/database-schema.md 13 protects by copying it at generation
--     time.
--   * `authenticated` gets no DELETE on bill_occurrences, ever. Removing a
--     scheduled row is safe; removing a paid or skipped one destroys payment
--     history, and a table-level DELETE grant (PostgreSQL has no column- or
--     predicate-scoped DELETE) cannot tell the two apart. Only a policy can,
--     and a policy on a role that never holds the grant is unreachable.
--
-- The recurrence machinery that *can* do both lives in `private`, is owned by
-- finance_snapshot_writer, and `authenticated` has no USAGE on that schema and
-- must never get one (090-privileges.sql asserts it; CP4's SECURITY INVOKER
-- RPCs depend on it staying true). So there is exactly one bridge across that
-- boundary, `public.maintain_bill_schedule`, built to the same rules as CP5's
-- `public.refresh_current_net_worth_snapshot`:
--
--   * Owned by the existing finance_snapshot_writer -- NOLOGIN, NOSUPERUSER,
--     NOBYPASSRLS, no application role is a member. Not postgres, whose
--     BYPASSRLS attribute would make a browser-reachable function into an RLS
--     bypass.
--   * `set search_path = ''`, every name schema-qualified.
--   * The owner is read from the request's own JWT claim
--     (`private.request_owner_id()`) and is never a parameter.
--   * No horizon, no date range, no month, no user. Its only addressable
--     argument is an owned bill id -- a business identifier the caller already
--     holds and can already read -- plus one boolean saying whether this is a
--     terms change (rebuild the future) or ordinary maintenance (top up).
--   * EXECUTE revoked from PUBLIC and anon; granted to authenticated, which is
--     required because the three INVOKER RPCs below run *as* authenticated and
--     call it inside their own transaction.
--   * The one new privilege it gains is DELETE on bill_occurrences, behind a
--     policy restricted to `status = 'scheduled'` **and** the calling
--     request's own rows -- so paid and skipped history is unreachable to it
--     at the policy layer, before `guard_bill_occurrence_delete()` (Phase 4)
--     is even consulted.
--
-- It gains nothing else. No access to categories, movements, budgets, goals or
-- goal_contributions; no INSERT/UPDATE/DELETE on bills; no UPDATE on
-- bill_occurrences at all -- the scheduler cannot rewrite an occurrence, only
-- add a scheduled one or remove a scheduled one.

-- ============================================================
-- bills -- column-scoped INSERT and UPDATE grants, no DELETE
-- ============================================================
-- `id` is granted on INSERT for the same client-minted-idempotency-key reason
-- as transactions.id, movements.id, budgets.id and goals.id: two bills with
-- the same name and amount are a legitimate pair (two phone lines), so nothing
-- about a submission's contents can tell a retry apart from a genuine second
-- one -- only a stable key can. `user_id` is INSERT-only, as on every table
-- here: a bill can never be re-homed.
--
-- Everything else about a bill is editable, including `anchor_date` and
-- `frequency`. That is the difference between a bill and a budget, and it is
-- deliberate: a budget's category and month decide what the row *is*, while a
-- bill's recurrence terms describe an ongoing arrangement with a landlord or
-- an insurer, and those genuinely change. What protects history is not
-- immutability of the parent but the fact that every occurrence's own
-- `amount_cents` was copied at generation time (docs/database-schema.md 13)
-- and that only *future scheduled* occurrences are ever rebuilt.
--
-- `created_at` is excluded, like everywhere else it exists -- it takes its
-- default.
--
-- No DELETE grant, and there will not be one. docs/database-schema.md 5's
-- rule for bills is soft-delete only ("occurrences retained regardless"), and
-- bill_occurrences' own composite FK back to bills is NO ACTION DEFERRABLE
-- rather than CASCADE, so a hard delete of a bill with any occurrence would
-- fail at COMMIT anyway.

grant insert (
  id,
  user_id,
  name,
  amount_cents,
  frequency,
  anchor_date,
  category_id,
  account_id
) on table public.bills to authenticated;

grant update (
  name,
  amount_cents,
  frequency,
  anchor_date,
  category_id,
  account_id,
  is_archived
) on table public.bills to authenticated;

-- ============================================================
-- bill_occurrences -- exactly the three status/payment columns
-- ============================================================
-- The complete list of what a person may change about a concrete occurrence:
-- whether it is scheduled, paid or skipped; when it was paid; and which of
-- their own transactions (if any) records that payment.
--
-- `amount_cents` and `due_date` are absent and that is the whole point of this
-- grant. They are the historical facts 13 exists to protect -- what this
-- instance was due for, and when -- and neither the owner nor the scheduler
-- may rewrite them in place. `id`, `user_id`, `bill_id` and `created_at` are
-- absent for the ownership and ordering reasons every other table here states.
--
-- No INSERT and no DELETE grant. See the header: an occurrence is generated,
-- not entered, and a paid or skipped one is history.

grant update (
  status,
  transaction_id,
  paid_on
) on table public.bill_occurrences to authenticated;

-- ============================================================
-- Operation-specific RLS policies for authenticated
-- ============================================================
-- `(select auth.uid())` wrapped exactly as every other policy in this schema
-- wraps it. UPDATE takes both USING and WITH CHECK, for the reason CP2 states:
-- USING decides which existing rows may be touched, WITH CHECK decides what
-- they may look like afterwards, and a policy relying on a grant's column list
-- for its own correctness would be one column edit away from being wrong.
--
-- Neither UPDATE policy carries an `is_archived = false` clause, on purpose.
-- Refusing to *edit* an archived bill is an application rule with a message
-- ("unarchive it first"), enforced in public.replace_bill below; putting it in
-- the policy as well would make unarchiving itself impossible, since that is
-- an UPDATE on an archived row.

create policy bills_insert_own on public.bills
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy bills_update_own on public.bills
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy bill_occurrences_update_own on public.bill_occurrences
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ============================================================
-- The scheduler's DELETE privilege -- narrower than any other writer grant
-- ============================================================
-- Phase 4's three writer policies on bills/bill_occurrences/net_worth_snapshots
-- are `using (true)`, justified there by the role being NOLOGIN with no members
-- and by every caller scoping to an explicit p_user_id. This one is tighter in
-- two independent ways, because a tighter predicate is available for free and
-- because DELETE is the one verb that can destroy history:
--
--   * `status = 'scheduled'` -- a paid or skipped occurrence is not visible to
--     this role's DELETE at all. Phase 4's guard_bill_occurrence_delete()
--     trigger still fires and still refuses one; this is the layer in front of
--     it, so the refusal is a policy fact rather than only a trigger fact.
--   * `user_id = private.request_owner_id()` -- scoped to the calling
--     request's own rows, exactly as CP5's profiles_select_writer is. A
--     session with no JWT claim (a psql shell, a cron job) can delete nothing
--     whatsoever, which is the correct answer for a scheduler that only ever
--     acts on behalf of a live request.
--
-- No INSERT or SELECT policy is added: Phase 4 already gave the writer both on
-- this table, and this migration does not widen either.

grant delete on table public.bill_occurrences to finance_snapshot_writer;

create policy bill_occurrences_delete_writer on public.bill_occurrences
  for delete to finance_snapshot_writer
  using (
    status = 'scheduled'
    and user_id = private.request_owner_id()
  );

-- ============================================================
-- assert_bill_refs -- BEFORE INSERT OR UPDATE on bills
-- ============================================================
-- The cross-row rules no GRANT, CHECK or policy can express, in the same
-- position and for the same reason as CP3's assert_transaction_refs() and
-- CP6's assert_budget_category_active_expense(): `authenticated` now holds a
-- direct INSERT/UPDATE privilege naming `category_id` and `account_id`, and
-- PostgREST is reachable from a browser with nothing but a session token, so a
-- rule enforced only in lib/data/mutations/bills.ts would be enforced only for
-- callers who choose to come through it.
--
--   1. A named category must not be archived. Nothing here constrains the
--      category's *kind*, and that is deliberate: no approved pre-CP7
--      requirement says a bill's category must be an expense category.
--      `bills.category_id` is a plain nullable composite FK with no CHECK, and
--      neither docs/database-schema.md 4/13 nor docs/rls-policies.md states a
--      kind rule for it. CP6's budgets rule is not transferable -- a budget is
--      a spending limit, so "expense" is what the row *means*, whereas a bill
--      is a recurring obligation whose category is a label. And
--      `guard_category_kind_change()` (CP2) naming `bills` proves only that a
--      referenced category's kind becomes immutable, not that the kind must be
--      `expense`. Inventing the narrower rule here would change what a `bills`
--      row is allowed to mean, so it is not invented.
--   2. A named account must not be archived. Archiving an account requires a
--      derived balance of exactly zero (accounts_guard_update()), and
--      lib/finance/accounts.ts excludes archived accounts from net worth -- so
--      pointing a live recurring obligation at one would name an account no
--      summary includes.
--
-- Both checks are skipped when the column is null: a bill legitimately has no
-- category and no account (docs/database-schema.md 4 -- both nullable), and
-- neither is required to track a recurring obligation.
--
-- ON UPDATE, each half runs **only when its own column actually changes.**
-- That is not an optimization. Without it, a bill whose category was archived
-- later could never be unarchived, renamed, or repriced again -- every one of
-- those is an UPDATE, and each would be refused by a rule about a column the
-- statement never touched. The rule belongs to the act of *pointing* a bill at
-- a category or an account, and that is exactly when it is checked.
--
-- Cross-owner references are deliberately not this trigger's business, for the
-- reason CP3 and CP6 both state: bills_category_fk and bills_account_fk are
-- composite (..., user_id) keys, which makes a foreign row structurally
-- impossible and already produces its own 23503. This trigger scopes its
-- lookups to the same composites and raises nothing when it finds no row.
--
-- SECURITY INVOKER with `search_path = ''`, like every other trigger function
-- here: the caller already holds SELECT on categories and accounts, and under
-- FORCE RLS the invoker sees exactly its own rows.

create function public.assert_bill_refs()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_category_archived boolean;
  v_account_archived boolean;
begin
  -- ---------- 1. An active category, when one is named ----------
  -- Kind is deliberately not examined. See the note above.
  if new.category_id is not null
     and (tg_op = 'INSERT' or new.category_id is distinct from old.category_id)
  then
    select c.is_archived
    into v_category_archived
    from public.categories c
    where c.id = new.category_id and c.user_id = new.user_id;

    -- `is_archived` is NOT NULL, so a null result means "no such visible row"
    -- and is the composite FK's business, not this trigger's.
    if v_category_archived is not null and v_category_archived then
      raise exception 'bill %: category % is archived', new.id, new.category_id
        using errcode = 'check_violation';
    end if;
  end if;

  -- ---------- 2. An active account, when one is named ----------
  if new.account_id is not null
     and (tg_op = 'INSERT' or new.account_id is distinct from old.account_id)
  then
    select a.is_archived
    into v_account_archived
    from public.accounts a
    where a.id = new.account_id and a.user_id = new.user_id;

    -- `is_archived` is NOT NULL, so a null result means "no such visible row"
    -- and is the composite FK's business, not this trigger's.
    if v_account_archived is not null and v_account_archived then
      raise exception 'bill %: account % is archived', new.id, new.account_id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.assert_bill_refs() from public, anon, authenticated;

create trigger bills_assert_refs
  before insert or update on public.bills
  for each row
  execute function public.assert_bill_refs();

-- ============================================================
-- guard_bill_occurrence_transition -- BEFORE UPDATE on bill_occurrences
-- ============================================================
-- The occurrence state machine, and the immutability of everything that is not
-- part of it.
--
-- Supported transitions, and nothing else:
--
--     scheduled -> paid        the obligation was met
--     scheduled -> skipped     the obligation did not apply this cycle
--     paid      -> scheduled   correction: unmark
--     skipped   -> scheduled   correction: unskip
--
-- A direct paid <-> skipped conversion is refused. The two are different
-- claims about what happened, and turning one into the other in a single
-- statement means the payment fields are being cleared or set as a side effect
-- of a status change nobody explicitly asked for. Going back through
-- `scheduled` costs one extra action and makes the correction visible as what
-- it is.
--
-- A no-op status (`old.status = new.status`) is allowed unconditionally, which
-- is what makes a resubmitted mark-paid or a double-clicked skip idempotent
-- rather than an error. The paid_on ceiling below still applies to it.
--
-- The payment-field consistency rules -- scheduled/skipped carry neither
-- `paid_on` nor `transaction_id`, paid requires `paid_on` -- are deliberately
-- NOT restated here. `bill_occurrences_status_consistency_ck` (Phase 4) is a
-- single-row CHECK that already enforces exactly that, on every write, from
-- every path. Restating it would create two expressions that have to agree
-- forever.
--
-- ## The paid_on ceiling
--
-- `paid_on` may not be later than the owner's own calendar day, computed as
-- `(now() at time zone <the owner's profiles.timezone>)::date` -- the same
-- expression assert_transaction_refs() (CP3), assert_goal_contribution_refs()
-- (CP6), public.refresh_current_net_worth_snapshot() (CP5) and
-- lib/data/clock.ts's getToday() all use, and never `current_date`, never
-- server UTC. For an owner in Auckland, server UTC is the *previous* day for
-- the first thirteen hours of every local day; for an owner in Los Angeles it
-- is the *next* day for the last seven hours. A ceiling read from the server's
-- clock would refuse a legitimate "I paid this today" for one of them and
-- accept a genuinely future date from the other.
--
-- `due_date` gets no such ceiling and never will: a bill is an obligation, and
-- every useful one is in the future.
--
-- ## Immutability of the rest of the row
--
-- `authenticated`'s UPDATE grant already names only (status, transaction_id,
-- paid_on), so for that role the columns below are unreachable at the
-- privilege layer. This restates it as a row-level fact that holds for *every*
-- role -- including finance_snapshot_writer, which holds no UPDATE grant here
-- at all and must never acquire one: the scheduler's whole contract is that it
-- may add a scheduled occurrence or remove a scheduled occurrence, and may
-- never rewrite one. An occurrence's amount and due date are the historical
-- facts docs/database-schema.md 13 exists to protect.
--
-- SECURITY INVOKER with `search_path = ''`.

create function public.guard_bill_occurrence_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_timezone text;
  v_today date;
begin
  -- ---------- Nothing but the state machine may move ----------
  if new.id <> old.id
     or new.user_id <> old.user_id
     or new.bill_id <> old.bill_id
     or new.due_date <> old.due_date
     or new.amount_cents <> old.amount_cents
     or new.created_at <> old.created_at
  then
    raise exception
      'bill occurrence %: only status, paid_on and transaction_id may be updated', old.id
      using errcode = 'check_violation';
  end if;

  -- ---------- The supported transitions ----------
  if new.status <> old.status
     and not (
       (old.status = 'scheduled' and new.status in ('paid', 'skipped'))
       or (old.status in ('paid', 'skipped') and new.status = 'scheduled')
     )
  then
    raise exception
      'bill occurrence %: % is not a supported transition from %', old.id, new.status, old.status
      using errcode = 'check_violation';
  end if;

  -- ---------- The paid_on ceiling, in the owner's own timezone ----------
  if new.status = 'paid' and new.paid_on is not null then
    select p.timezone into v_timezone
    from public.profiles p
    where p.id = new.user_id;

    -- Not visible to this statement: RLS or the NOT DEFERRABLE FK to profiles
    -- already refuses this write, exactly as assert_transaction_refs() reasons
    -- for the identical case.
    if v_timezone is not null then
      v_today := (now() at time zone v_timezone)::date;

      if new.paid_on > v_today then
        raise exception
          'bill occurrence %: paid_on is later than the owner''s current calendar day', new.id
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_bill_occurrence_transition()
  from public, anon, authenticated;

create trigger bill_occurrences_guard_transition
  before update on public.bill_occurrences
  for each row
  execute function public.guard_bill_occurrence_transition();

-- ============================================================
-- private.generate_bill_occurrences_for_bill -- one bill, one window
-- ============================================================
-- The Phase 4 generator, `private.generate_bill_occurrences(p_user_id,
-- p_horizon_date)`, walks *every* active bill an owner has and starts each
-- one's walk at `max(due_date)` for that bill. Both of those are wrong for
-- CP7, for reasons that are not stylistic:
--
--   * **Per bill, not per owner.** A bill edit rebuilds exactly one bill's
--     future schedule. Running the owner-wide generator would silently
--     extend every *other* bill's horizon as a side effect of editing one --
--     and, in the "the new anchor is beyond the usual horizon" case below,
--     would extend them by however far that one anchor reached.
--   * **From the anchor, not from `max(due_date)`.** `max(due_date)` is only
--     a valid starting point when the last stored occurrence is itself a
--     member of the current series. After an anchor or frequency change it is
--     not -- and `next_bill_occurrence_date(anchor, freq, after)` advances in
--     whole periods *from the anchor's own month*, so handing it a due date
--     from the old series can skip the first occurrence of the new one
--     outright. Walking the new series from its own anchor is the only
--     formulation that cannot drift.
--
-- What is emphatically NOT re-implemented here is the recurrence arithmetic.
-- Every candidate date comes from `private.next_bill_occurrence_date` --
-- Phase 4's pure, IMMUTABLE function, with its month-end clamping and
-- leap-year recovery, proven by 070-recurrence.sql. This function is a window
-- and a loop around it, nothing more.
--
-- `p_from_date` is the lower bound, and it exists so that generation can never
-- invent historical obligations. Its two values are decided by the caller
-- below from a fact about the bill, never by a parameter a client supplies.
--
-- Inserts are `on conflict (bill_id, due_date) do nothing`, exactly as the
-- Phase 4 generator's are. That unique index is what makes generation
-- idempotent, and -- more importantly here -- what makes a preserved paid,
-- skipped or overdue-scheduled occurrence untouchable: a regenerated series
-- landing on the same date as an existing row leaves that row exactly as it
-- was, amount included.
--
-- The iteration cap is a guard against a pathological anchor (a weekly bill
-- anchored decades ago), not a business rule. It raises rather than silently
-- truncating, because a silently short schedule is the failure mode that is
-- hardest to notice.
--
-- Lives in `private` and is therefore unreachable by `authenticated` at the
-- schema level, whatever any function-level grant says. SECURITY INVOKER: its
-- only caller is the SECURITY DEFINER bridge below, so it runs as
-- finance_snapshot_writer and uses that role's own SELECT on bills and
-- SELECT+INSERT on bill_occurrences -- the same arrangement Phase 4 uses for
-- next_bill_occurrence_date.

create function private.generate_bill_occurrences_for_bill(
  p_bill_id uuid,
  p_user_id uuid,
  p_from_date date,
  p_horizon_date date
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c_max_iterations constant integer := 5000;
  v_amount_cents bigint;
  v_frequency public.bill_frequency;
  v_anchor_date date;
  v_is_archived boolean;
  v_next_due date;
  v_iterations integer := 0;
  v_inserted integer := 0;
begin
  select b.amount_cents, b.frequency, b.anchor_date, b.is_archived
  into v_amount_cents, v_frequency, v_anchor_date, v_is_archived
  from public.bills b
  where b.id = p_bill_id and b.user_id = p_user_id;

  -- No such bill for this owner. The caller has already refused that case with
  -- a message; returning zero here keeps this function total.
  if v_anchor_date is null then
    return 0;
  end if;

  -- An archived bill generates nothing. Archiving is how a person says "stop
  -- tracking this", and the Phase 4 generator's own inclusion rule
  -- (`is_archived = false`) says the same thing.
  if v_is_archived then
    return 0;
  end if;

  v_next_due := v_anchor_date;

  while v_next_due <= p_horizon_date loop
    v_iterations := v_iterations + 1;
    if v_iterations > c_max_iterations then
      raise exception
        'bill %: the recurrence from its first due date to the schedule horizon is too long', p_bill_id
        using errcode = 'check_violation';
    end if;

    -- Candidates before the lower bound are stepped over, never written. This
    -- is what keeps a rebuild from back-filling a new series across dates that
    -- have already passed -- occurrences nobody was ever obliged to pay.
    if v_next_due >= p_from_date then
      insert into public.bill_occurrences (user_id, bill_id, due_date, status, amount_cents)
      values (p_user_id, p_bill_id, v_next_due, 'scheduled', v_amount_cents)
      on conflict (bill_id, due_date) do nothing;

      if found then
        v_inserted := v_inserted + 1;
      end if;
    end if;

    v_next_due := private.next_bill_occurrence_date(v_anchor_date, v_frequency, v_next_due);
  end loop;

  return v_inserted;
end;
$$;

revoke execute on function private.generate_bill_occurrences_for_bill(uuid, uuid, date, date)
  from public, anon, authenticated;

-- The global default-privilege revoke in migration 1 means a new function
-- grants EXECUTE to nobody but its creator, so the writer needs it explicitly
-- -- the same statement private.next_bill_occurrence_date needed in migration
-- 7 and private.request_owner_id needed in CP5.
grant execute on function private.generate_bill_occurrences_for_bill(uuid, uuid, date, date)
  to finance_snapshot_writer;

-- ============================================================
-- public.maintain_bill_schedule -- the bridge
-- ============================================================
-- Derive the owner from the request's own claim, take that owner's calendar
-- day, and bring one owned bill's *future* schedule into line with its current
-- terms. Every other input is fixed; none is a parameter.
--
-- ## The rolling horizon: one year, chosen here and nowhere else
--
-- The repository had no horizon locked -- Phase 4's generator takes one as a
-- parameter and Phase 4 deliberately never scheduled a caller. CP7 fixes it at
-- **one year from the owner's own today**, in this function, as a constant no
-- client can reach. One year is the conservative choice for the three things
-- the schedule has to support:
--
--   * a yearly bill always has its next occurrence, which is the frequency
--     that would break first under a shorter window;
--   * `getBills()` and the dashboard's upcoming-bill projection always find a
--     next scheduled occurrence for every active bill;
--   * a weekly bill needs ~52 rows once, rather than one generation pass per
--     page load -- generation is mutation-time maintenance here, never a
--     render-time side effect, and no read path in this application calls this
--     function at all.
--
-- The horizon is `greatest(today + 1 year, the bill's anchor date)`. The
-- second term is not a rounding detail: a bill whose first tracked due date is
-- deliberately further out than a year (an annual premium set up early, a
-- lease starting next autumn) would otherwise generate *nothing at all* and be
-- invisible on /bills -- which reads exactly like the create having failed.
-- Widening to the anchor produces precisely one occurrence in that case, since
-- the following one is a whole period beyond it.
--
-- ## The lower bound: derived from the bill, never supplied
--
-- Generation starts at the bill's own anchor date **only when the bill has no
-- occurrence at all** -- which is true exactly once, at creation, and is what
-- lets someone track a bill whose first due date has already passed (an
-- invoice that arrived late is a real, overdue obligation). Every later call
-- starts at the owner's today, so no rebuild can ever manufacture an
-- obligation on a date in the past.
--
-- The flag is computed *before* the delete below, so a rebuild that removes
-- every future scheduled row cannot make an existing bill look new.
--
-- ## p_rebuild_future
--
-- `true` for a change to the bill's amount, frequency or anchor date -- the
-- three terms that determine what the future schedule should be. Scheduled
-- occurrences due **on or after the owner's today** are deleted and rebuilt
-- from the new terms; everything earlier, and everything paid or skipped, is
-- untouched by construction: the DELETE names `status = 'scheduled'` and
-- `due_date >= today`, and the writer's own DELETE policy independently
-- refuses any row that is not scheduled and not this request's own.
--
-- `false` for ordinary maintenance -- a create, an unarchive, an occurrence
-- status change. Nothing is deleted; the generator tops the horizon up and
-- `on conflict do nothing` makes every existing row a no-op. That distinction
-- is worth a parameter: a status change has no business rewriting the future
-- schedule, and a needless delete-and-recreate would give every future row a
-- new id and `created_at` for no reason.
--
-- Reaching this function directly with `true` for one's own bill is harmless
-- and idempotent -- it recomputes the same future schedule from the same
-- stored terms -- which is why the flag can be a parameter at all while an
-- owner, a horizon or a date range cannot.
--
-- ## Errors
--
-- Error text names a bill id (a value the caller supplied and can already
-- read) and nothing else. No amount, no date, no owner id.

create function public.maintain_bill_schedule(
  p_bill_id uuid,
  p_rebuild_future boolean
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_horizon constant interval := interval '1 year';
  v_owner_id uuid := private.request_owner_id();
  v_timezone text;
  v_today date;
  v_anchor_date date;
  v_is_archived boolean;
  v_had_any_occurrence boolean;
  v_from_date date;
  v_horizon_date date;
begin
  if v_owner_id is null then
    raise exception 'maintain_bill_schedule requires an authenticated caller'
      using errcode = 'invalid_authorization_specification';
  end if;

  if p_bill_id is null or p_rebuild_future is null then
    raise exception 'maintain_bill_schedule: bill and rebuild flag are both required'
      using errcode = 'check_violation';
  end if;

  -- Ownership is asserted explicitly as well as by the policies, per the same
  -- defense-in-depth rule every other lookup in this schema follows. The
  -- writer's `bills_select_writer` policy is `using (true)`, so this predicate
  -- is what scopes the read -- and it is the only thing standing between this
  -- function and another owner's bill.
  select b.anchor_date, b.is_archived
  into v_anchor_date, v_is_archived
  from public.bills b
  where b.id = p_bill_id and b.user_id = v_owner_id;

  if v_anchor_date is null then
    raise exception 'maintain_bill_schedule: bill % is not available', p_bill_id
      using errcode = 'foreign_key_violation';
  end if;

  -- An archived bill keeps every occurrence it has and gains none. Nothing is
  -- deleted either: docs/database-schema.md 5's rule is that occurrences are
  -- retained regardless.
  if v_is_archived then
    return 0;
  end if;

  select p.timezone into v_timezone
  from public.profiles p
  where p.id = v_owner_id;

  if v_timezone is null then
    raise exception 'maintain_bill_schedule: the caller has no profile'
      using errcode = 'no_data_found';
  end if;

  v_today := (now() at time zone v_timezone)::date;

  select exists (
    select 1
    from public.bill_occurrences o
    where o.bill_id = p_bill_id and o.user_id = v_owner_id
  ) into v_had_any_occurrence;

  if p_rebuild_future then
    delete from public.bill_occurrences o
    where o.bill_id = p_bill_id
      and o.user_id = v_owner_id
      and o.status = 'scheduled'
      and o.due_date >= v_today;
  end if;

  v_from_date := case when v_had_any_occurrence then v_today else v_anchor_date end;
  v_horizon_date := greatest((v_today + c_horizon)::date, v_anchor_date);

  return private.generate_bill_occurrences_for_bill(
    p_bill_id,
    v_owner_id,
    v_from_date,
    v_horizon_date
  );
end;
$$;

-- ALTER FUNCTION ... OWNER TO requires the incoming owner to hold CREATE on
-- the containing schema. finance_snapshot_writer holds CREATE on `private`
-- (migration 7) and deliberately holds none on `public`, so the privilege is
-- granted for exactly this statement and taken straight back -- the same
-- arrangement CP5 uses, and 090-privileges.sql asserts the role ends up with
-- no standing CREATE on public.
grant create on schema public to finance_snapshot_writer;

alter function public.maintain_bill_schedule(uuid, boolean)
  owner to finance_snapshot_writer;

revoke create on schema public from finance_snapshot_writer;

revoke execute on function public.maintain_bill_schedule(uuid, boolean)
  from public, anon;

grant execute on function public.maintain_bill_schedule(uuid, boolean)
  to authenticated;

-- ============================================================
-- public.create_bill -- the bill and its first schedule, atomically
-- ============================================================
-- SECURITY INVOKER (the default, prosecdef = false), like CP4's movement RPCs
-- and CP5's reconcile_account. The caller already holds every privilege the
-- INSERT below uses, and under FORCE RLS `bills_insert_own` is the enforced
-- floor. A definer's context would not add a check here; it would remove the
-- RLS that backs the statement.
--
-- The owner comes from `auth.uid()` and is never a parameter. There is no
-- p_user_id here and there must never be one.
--
-- ## Why this is a function at all, given the INSERT grant exists
--
-- Because a bill with no schedule is not a bill this application can show. The
-- INSERT and the generation have to commit together, and PostgREST issues one
-- statement per request in its own transaction -- so two calls cannot do it.
-- If generation raises (a pathological anchor, a missing profile), the whole
-- transaction rolls back and no bill is left behind.
--
-- ## Idempotency
--
-- `p_bill_id` is a client-minted UUID used verbatim as the row's `id`, so a
-- retried or double-clicked submission collides with itself on the primary key
-- and raises 23505 out of this function. Deciding what that collision *means*
-- is deliberately not done here: lib/data/mutations/bills.ts re-reads its own
-- row and compares the complete payload, exactly as CP3's createTransaction
-- and CP4's createMovement do. There is no idempotency table.
--
-- Everything else is left to the layers that already own it: the column-scoped
-- GRANT, `bills_insert_own`, the two composite FKs, and `assert_bill_refs()`.

create function public.create_bill(
  p_bill_id uuid,
  p_name text,
  p_amount_cents bigint,
  p_frequency public.bill_frequency,
  p_anchor_date date,
  p_category_id uuid,
  p_account_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_generated integer;
begin
  if v_owner_id is null then
    raise exception 'create_bill requires an authenticated caller'
      using errcode = 'invalid_authorization_specification';
  end if;

  if p_bill_id is null or p_name is null or p_amount_cents is null
     or p_frequency is null or p_anchor_date is null
  then
    raise exception 'create_bill: bill, name, amount, frequency and first due date are all required'
      using errcode = 'check_violation';
  end if;

  insert into public.bills
    (id, user_id, name, amount_cents, frequency, anchor_date, category_id, account_id)
  values
    (p_bill_id, v_owner_id, p_name, p_amount_cents, p_frequency, p_anchor_date,
     p_category_id, p_account_id);

  -- Same transaction, so the bill this reads is the one just inserted.
  v_generated := public.maintain_bill_schedule(p_bill_id, false);

  return jsonb_build_object(
    'id', p_bill_id,
    'rebuilt', false,
    'generated', v_generated
  );
end;
$$;

revoke execute on function public.create_bill(uuid, text, bigint, public.bill_frequency, date, uuid, uuid)
  from public, anon;

grant execute on function public.create_bill(uuid, text, bigint, public.bill_frequency, date, uuid, uuid)
  to authenticated;

-- ============================================================
-- public.replace_bill -- the edit, and the future schedule that follows it
-- ============================================================
-- SECURITY INVOKER, same reasoning as create_bill. The bill keeps its id: an
-- edit is an edit, and every occurrence's composite FK back to
-- (bills.id, user_id) stays valid throughout.
--
-- ## What "terms changed" means, and why only that triggers a rebuild
--
-- `amount_cents`, `frequency` and `anchor_date` are the three columns that
-- decide what the future schedule should look like. A change to any of them
-- makes every *future scheduled* occurrence wrong, so they are rebuilt.
--
-- `name`, `category_id` and `account_id` decide none of it. A rename or a
-- recategorisation leaves the schedule exactly as correct as it was, and
-- rebuilding anyway would hand every future row a new id and `created_at` for
-- no reason. So a metadata-only edit deliberately does not call the scheduler
-- at all -- and the returned `rebuilt` flag says which happened, so the
-- application layer can assert it rather than infer it.
--
-- ## Atomicity
--
-- The UPDATE and the rebuild are one transaction. If the rebuild raises, the
-- edit rolls back with it and the old bill *and* its old schedule survive
-- byte for byte -- which is the property that makes it safe to delete future
-- scheduled rows before regenerating them.
--
-- ## Archived bills
--
-- Refused, with a message. The database could permit it -- `bills_update_own`
-- deliberately carries no archive clause, because unarchiving is itself an
-- UPDATE on an archived row -- but editing a bill nobody is tracking, whose
-- schedule cannot be regenerated while archived, would silently leave the
-- terms and the schedule disagreeing until some later unarchive. "Unarchive
-- it first" is the honest answer.

create function public.replace_bill(
  p_bill_id uuid,
  p_name text,
  p_amount_cents bigint,
  p_frequency public.bill_frequency,
  p_anchor_date date,
  p_category_id uuid,
  p_account_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_is_archived boolean;
  v_amount_cents bigint;
  v_frequency public.bill_frequency;
  v_anchor_date date;
  v_terms_changed boolean;
  v_generated integer := 0;
begin
  if v_owner_id is null then
    raise exception 'replace_bill requires an authenticated caller'
      using errcode = 'invalid_authorization_specification';
  end if;

  if p_bill_id is null or p_name is null or p_amount_cents is null
     or p_frequency is null or p_anchor_date is null
  then
    raise exception 'replace_bill: bill, name, amount, frequency and first due date are all required'
      using errcode = 'check_violation';
  end if;

  select b.is_archived, b.amount_cents, b.frequency, b.anchor_date
  into v_is_archived, v_amount_cents, v_frequency, v_anchor_date
  from public.bills b
  where b.id = p_bill_id and b.user_id = v_owner_id;

  if v_is_archived is null then
    raise exception 'replace_bill: bill % is not available', p_bill_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_is_archived then
    raise exception 'replace_bill: bill % is archived', p_bill_id
      using errcode = 'check_violation';
  end if;

  v_terms_changed := (
    v_amount_cents <> p_amount_cents
    or v_frequency <> p_frequency
    or v_anchor_date <> p_anchor_date
  );

  update public.bills b
  set name = p_name,
      amount_cents = p_amount_cents,
      frequency = p_frequency,
      anchor_date = p_anchor_date,
      category_id = p_category_id,
      account_id = p_account_id
  where b.id = p_bill_id and b.user_id = v_owner_id;

  if v_terms_changed then
    v_generated := public.maintain_bill_schedule(p_bill_id, true);
  end if;

  return jsonb_build_object(
    'id', p_bill_id,
    'rebuilt', v_terms_changed,
    'generated', v_generated
  );
end;
$$;

revoke execute on function public.replace_bill(uuid, text, bigint, public.bill_frequency, date, uuid, uuid)
  from public, anon;

grant execute on function public.replace_bill(uuid, text, bigint, public.bill_frequency, date, uuid, uuid)
  to authenticated;

-- ============================================================
-- public.set_bill_archived -- soft delete, and the horizon on the way back
-- ============================================================
-- SECURITY INVOKER. A function rather than a plain PostgREST update for one
-- reason: unarchiving has to restore a usable future horizon, and doing that
-- in a second request means an unarchived bill can sit with no next scheduled
-- occurrence -- invisible on /bills and on the dashboard -- if that request
-- fails. Here the flag and the horizon move together or not at all.
--
-- Archiving deletes nothing and generates nothing: every occurrence is
-- retained (docs/database-schema.md 5), and `getBills()`'s own
-- `is_archived = false` filter is what removes the bill from the active and
-- upcoming projections. `maintain_bill_schedule` returns 0 for an archived
-- bill regardless, so the asymmetry below is explicit rather than incidental.
--
-- Unarchiving tops the horizon up (`p_rebuild_future = false`): every existing
-- occurrence -- paid, skipped, and any scheduled row that went overdue while
-- the bill was archived -- survives untouched, and generation resumes from the
-- owner's today rather than back-filling the gap. Nobody owed anything on a
-- bill they had stopped tracking.

create function public.set_bill_archived(
  p_bill_id uuid,
  p_archived boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_is_archived boolean;
  v_generated integer := 0;
begin
  if v_owner_id is null then
    raise exception 'set_bill_archived requires an authenticated caller'
      using errcode = 'invalid_authorization_specification';
  end if;

  if p_bill_id is null or p_archived is null then
    raise exception 'set_bill_archived: bill and archive state are both required'
      using errcode = 'check_violation';
  end if;

  select b.is_archived into v_is_archived
  from public.bills b
  where b.id = p_bill_id and b.user_id = v_owner_id;

  if v_is_archived is null then
    raise exception 'set_bill_archived: bill % is not available', p_bill_id
      using errcode = 'foreign_key_violation';
  end if;

  update public.bills b
  set is_archived = p_archived
  where b.id = p_bill_id and b.user_id = v_owner_id;

  if not p_archived then
    v_generated := public.maintain_bill_schedule(p_bill_id, false);
  end if;

  return jsonb_build_object(
    'id', p_bill_id,
    'archived', p_archived,
    'generated', v_generated
  );
end;
$$;

revoke execute on function public.set_bill_archived(uuid, boolean) from public, anon;

grant execute on function public.set_bill_archived(uuid, boolean) to authenticated;
