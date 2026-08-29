-- Phase 7 Checkpoint 6: budget and goal writes.
--
-- Three tables move off the Phase 4 read-only posture together: budgets,
-- goals, and goal_contributions. No earlier migration is edited, and no
-- privilege CP2-CP5 already granted is touched -- 100-write-grants.sql still
-- asserts every earlier table's matrix unchanged, and this migration only
-- adds three new rows to it.
--
-- The three tables get three different shapes of write access, on purpose:
--
--   * budgets is planning metadata, not ledger history. It gets ordinary
--     INSERT/UPDATE/DELETE -- narrowly column-scoped, like every grant in
--     this schema -- because a budget with the wrong limit or the wrong
--     category is simply wrong, not a historical fact to preserve. `period`
--     and `category_id` are INSERT-only: the application only ever manages
--     the owner's *current* month, and CP2's precedent (accounts.type,
--     categories.kind's initial value) is that a column deciding what a row
--     fundamentally *is* is chosen once, at creation, and never moved.
--   * goals follow the CP2 accounts/categories pattern exactly: soft-delete
--     via `archived_at`, no DELETE grant at all, `target_cents`/`target_date`
--     editable like any other metadata.
--   * goal_contributions stays append-only, as docs/database-schema.md §12
--     always said it would: INSERT only, no UPDATE, no DELETE, ever. A
--     correction is a new signed row, not an edit to an old one.
--
-- Two new BEFORE INSERT triggers carry the cross-row rules no GRANT, CHECK,
-- or policy can express -- the same reason CP3's assert_transaction_refs()
-- exists. Both are SECURITY INVOKER, search_path = '', and fire on INSERT
-- only: budgets.category_id and goal_contributions.goal_id are both
-- INSERT-only columns (neither is in its table's UPDATE grant below), so
-- there is nothing for a BEFORE UPDATE half of either trigger to check.
--
-- `anon` is not named in a single GRANT or policy below.

-- ============================================================
-- budgets -- column-scoped INSERT, UPDATE and DELETE grants
-- ============================================================
-- `id` is granted on INSERT, in the same spirit as CP3's transactions.id:
-- the create form mints one client-side UUID per submission, so a retry
-- collides with itself on the primary key instead of silently accepting
-- (or rejecting) a second identical-looking budget. `user_id` is
-- INSERT-only for the same ownership reason as every other table here.
--
-- `category_id` and `period` are INSERT-only. Both decide what the row
-- fundamentally *is* -- which category this budget tracks, which month it
-- applies to -- and the roadmap's own rule is that the current-month UI
-- never edits either in place: getting the category or the month wrong
-- means deleting the budget and creating the right one, which the DELETE
-- grant below exists to support. `created_at` does not exist on this table
-- at all, so there is nothing to omit for it.
--
-- `limit_cents` is the only UPDATE column, and it is the only thing about
-- an existing budget a person should ever need to change: the amount they
-- plan to spend.

grant insert (
  id,
  user_id,
  category_id,
  period,
  limit_cents
) on table public.budgets to authenticated;

grant update (limit_cents) on table public.budgets to authenticated;

-- Table-level, like every DELETE grant in this schema (PostgreSQL has no
-- column-level DELETE). A budget is planning metadata, not a ledger row --
-- unlike a transaction, deleting one destroys no financial history, so a
-- hard delete needs no archive-flag alternative and no guard trigger.
grant delete on table public.budgets to authenticated;

-- ============================================================
-- goals -- column-scoped INSERT and UPDATE grants, no DELETE
-- ============================================================
-- The CP2 accounts/categories shape, transplanted: `id` and `user_id` are
-- INSERT-only for the reasons above; `name`, `target_cents` and
-- `target_date` are editable at any time, including while the goal is
-- archived -- editing a goal's target does not touch a single contribution
-- row, so there is nothing here for archiving to protect. `archived_at` is
-- UPDATE-only, exactly like `accounts.is_archived`: a goal may never be
-- *created* already archived.
--
-- No DELETE grant, and there will not be one. docs/database-schema.md §5's
-- rule for goals is soft-delete only -- "deleting a goal must not silently
-- destroy its financial history" -- and goal_contributions' own FK back to
-- goals (NO ACTION DEFERRABLE, not CASCADE) means a hard delete of a goal
-- with any contribution would fail at COMMIT regardless.

grant insert (
  id,
  user_id,
  name,
  target_cents,
  target_date
) on table public.goals to authenticated;

grant update (
  name,
  target_cents,
  target_date,
  archived_at
) on table public.goals to authenticated;

-- ============================================================
-- goal_contributions -- INSERT only, permanently
-- ============================================================
-- No UPDATE grant, no DELETE grant, and neither will ever be added --
-- append-only is the entire point of this table (docs/database-schema.md
-- §12). A correction or a withdrawal is a new signed row, never an edit to
-- an old one, which is what keeps `saved_cents` a genuine audit trail
-- rather than a mutable ledger that happens to be summed.
--
-- `id` is granted for the same client-minted-idempotency-key reason as
-- transactions.id and budgets.id above: two identical real contributions
-- (a person deposits the same round number into the same goal twice in one
-- day) are legitimate distinct events, so nothing about a row's contents
-- can tell a retry apart from a second one -- only a stable key can.
-- `goal_id` is required to name which goal the row belongs to; `note` is
-- optional free text.

grant insert (
  id,
  user_id,
  goal_id,
  amount_cents,
  occurred_on,
  note
) on table public.goal_contributions to authenticated;

-- ============================================================
-- Operation-specific RLS policies
-- ============================================================
-- (select auth.uid()) wrapped exactly as every other policy in this schema
-- wraps it. UPDATE takes both USING and WITH CHECK for the same reason CP2
-- states it: USING decides which existing rows may be touched, WITH CHECK
-- decides what they may look like afterwards, and a policy that depended on
-- a grant's column list alone for its own correctness would be one column
-- edit away from being wrong.

create policy budgets_insert_own on public.budgets
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy budgets_update_own on public.budgets
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy budgets_delete_own on public.budgets
  for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy goals_insert_own on public.goals
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy goals_update_own on public.goals
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy goal_contributions_insert_own on public.goal_contributions
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- ============================================================
-- assert_budget_category_active_expense -- BEFORE INSERT on budgets
-- ============================================================
-- The one rule no GRANT, CHECK or policy can express: a budget's category
-- must be an *active expense* category. `authenticated` now holds a direct
-- INSERT privilege naming `category_id`, and PostgREST is reachable from a
-- browser with nothing but a session token -- so a rule enforced only in
-- lib/data/mutations/budgets.ts would be enforced only for callers who
-- choose to come through it.
--
-- Cross-owner references are deliberately not this trigger's business, for
-- the same reason CP3's assert_transaction_refs() leaves them to the
-- composite FK: budgets_category_fk is (category_id, user_id) ->
-- categories(id, user_id), which makes a foreign category structurally
-- impossible and already produces its own 23503 for one. This trigger scopes
-- its lookup to the same composite and raises nothing when it finds no
-- row, deferring to that FK exactly as assert_transaction_refs() does.
--
-- BEFORE INSERT only. category_id is not in the UPDATE grant above, so there
-- is no UPDATE statement this trigger would ever need to examine -- the rule
-- is checked once, at the moment it can be set, and never has to be
-- rechecked because it can never change.
--
-- SECURITY INVOKER (the default) with search_path = '', like every other
-- trigger function in this schema: `authenticated` already holds SELECT on
-- categories, and under FORCE RLS the invoker sees exactly its own row --
-- which is exactly the scope this lookup wants.

create function public.assert_budget_category_active_expense()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_kind public.category_kind;
  v_archived boolean;
begin
  select c.kind, c.is_archived into v_kind, v_archived
  from public.categories c
  where c.id = new.category_id and c.user_id = new.user_id;

  -- Not found: the composite FK owns that case (a foreign or nonexistent
  -- category), exactly as assert_transaction_refs() defers to it.
  if v_kind is not null then
    if v_archived then
      raise exception 'budget %: category % is archived', new.id, new.category_id
        using errcode = 'check_violation';
    end if;

    if v_kind <> 'expense' then
      raise exception 'budget %: category % is not an expense category', new.id, new.category_id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.assert_budget_category_active_expense()
  from public, anon, authenticated;

create trigger budgets_assert_category
  before insert on public.budgets
  for each row
  execute function public.assert_budget_category_active_expense();

-- ============================================================
-- assert_goal_contribution_refs -- BEFORE INSERT on goal_contributions
-- ============================================================
-- Two cross-row rules, mirroring assert_transaction_refs()'s posted-date
-- ceiling and archived-account refusal for exactly the same reason:
-- `authenticated` now holds a direct INSERT privilege on this table.
--
--   1. `occurred_on` may not be later than the owner's own calendar day,
--      computed the identical way assert_transaction_refs() computes it --
--      `(now() at time zone <the owner's profiles.timezone>)::date` -- so a
--      contribution form's ceiling and the database's refusal can never
--      disagree, on this table any more than on transactions.
--   2. The target goal must not be archived. Archiving a goal is how a
--      person says "I'm done contributing to this", and honouring that only
--      in the picker would mean a stale form -- or a hand-crafted request --
--      could reopen it. Every existing contribution stays exactly as it
--      was; only new ones are refused.
--
-- Cross-owner references are, again, not this trigger's business:
-- goal_contributions_goal_fk is (goal_id, user_id) -> goals(id, user_id),
-- so a foreign goal is structurally impossible and produces its own 23503.
-- FOUND is used rather than "is not null" for the archived check, unlike
-- assert_transaction_refs()'s category-kind lookup: `archived_at` is
-- genuinely nullable for a row that *was* found (an active goal), so a null
-- result cannot be read as "not found" the way a NOT NULL column's null
-- can.
--
-- BEFORE INSERT only -- goal_contributions has no UPDATE grant at all, so
-- there is no UPDATE statement to guard against.
--
-- SECURITY INVOKER with search_path = '', for the same reason as every
-- other trigger function here: the caller already holds SELECT on profiles
-- and goals, and under FORCE RLS the invoker sees exactly its own rows.

create function public.assert_goal_contribution_refs()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_timezone text;
  v_today date;
  v_goal_archived_at timestamptz;
begin
  -- ---------- 1. Posted-date ceiling, in the owner's timezone ----------
  select p.timezone into v_timezone
  from public.profiles p
  where p.id = new.user_id;

  -- Not visible to this statement: RLS or the NOT DEFERRABLE FK to profiles
  -- already refuses this write, exactly as assert_transaction_refs()
  -- reasons for the identical case.
  if v_timezone is not null then
    v_today := (now() at time zone v_timezone)::date;

    if new.occurred_on > v_today then
      raise exception
        'goal_contribution %: occurred_on is later than the owner''s current calendar day', new.id
        using errcode = 'check_violation';
    end if;
  end if;

  -- ---------- 2. The goal may not be archived ----------
  select g.archived_at into v_goal_archived_at
  from public.goals g
  where g.id = new.goal_id and g.user_id = new.user_id;

  -- FOUND is required here, unlike the budget category check above:
  -- archived_at is nullable for an existing, active goal, so a null result
  -- alone cannot distinguish "not found" from "found and not archived".
  if found and v_goal_archived_at is not null then
    raise exception 'goal_contribution %: goal % is archived', new.id, new.goal_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke execute on function public.assert_goal_contribution_refs()
  from public, anon, authenticated;

create trigger goal_contributions_assert_refs
  before insert on public.goal_contributions
  for each row
  execute function public.assert_goal_contribution_refs();
