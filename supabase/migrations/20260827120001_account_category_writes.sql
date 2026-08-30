-- Phase 7 Checkpoint 2: account and category writes.
--
-- The first migration in this repository that grants `authenticated`
-- anything beyond SELECT. It opens exactly two tables -- accounts and
-- categories -- and nothing else: transactions, movements, budgets,
-- bills, bill_occurrences, goals, goal_contributions,
-- net_worth_snapshots, and profiles all keep their Phase 4 read-only
-- posture, unchanged. That claim is a checked fact, not a promise:
-- supabase/tests/database/100-write-grants.sql asserts the exact
-- privilege matrix table by table, for both application roles, and
-- proves its own table list is complete.
--
-- No Phase 4 migration is modified. Everything here is additive.
--
-- Four things land together, and all four are required -- none
-- substitutes for another (docs/rls-policies.md §2, §5):
--
--   1. COLUMN-SCOPED grants. RLS filters rows, not columns; a
--      FOR UPDATE policy matching auth.uid() = user_id would otherwise
--      permit rewriting *every* column on a matched row, `user_id`
--      included. The column list is therefore the only thing standing
--      between "edit my account's name" and "reassign my account to
--      someone else", and it is expressed where it belongs: in the
--      GRANT (docs/rls-policies.md §4, "Column-scoped updates are a
--      GRANT concern, not an RLS concern").
--   2. OPERATION-SPECIFIC RLS policies -- one per operation, role-
--      targeted, never FOR ALL. Both an INSERT WITH CHECK and an
--      UPDATE USING + WITH CHECK, so a row can be neither created for
--      nor moved to another owner.
--   3. accounts_guard_update() -- a BEFORE UPDATE trigger enforcing the
--      three account invariants the grant layer cannot express.
--   4. guard_category_kind_change() -- the same, for category kind.
--
-- No DELETE grant and no DELETE policy is created for either table.
-- Both use archival (`is_archived`), which is why the roadmap's policy
-- matrix records DELETE on these tables as "prefer archive" rather than
-- "Phase 7". `anon` gains nothing here -- it is not named in a single
-- GRANT or policy below, and its Phase 4 posture (zero privileges on
-- every user-financial table and view) is untouched.

-- ============================================================
-- accounts -- column-scoped INSERT and UPDATE grants
-- ============================================================
-- INSERT names `user_id` because the ownership predicate needs it: the
-- WITH CHECK below compares it against auth.uid(), so the column must
-- be assignable for a row to be insertable at all. It is deliberately
-- absent from the UPDATE list -- an owned row can never be re-homed.
--
-- `id` and `created_at` appear in neither list. Both have defaults, and
-- a column not named in a column-scoped INSERT grant simply takes its
-- default rather than failing, so omitting them from INSERT costs
-- nothing and removes any way to choose a row's id or backdate it.
--
-- `type` is INSERT-only: an account's type decides its asset/liability
-- classification, which credit/interest columns are even legal on it
-- (accounts_credit_limit_domain_ck, accounts_interest_rate_domain_ck),
-- and how every historical net-worth snapshot already classified it.
-- Changing it after the fact silently rewrites the meaning of data
-- that has already been read, reported, and snapshotted.
--
-- `is_archived` is UPDATE-only, and the inverse of `type`: an account
-- may never be *created* already archived (a row nothing can be
-- entered against, arriving with no history), but archiving and
-- unarchiving an existing one is exactly what the UI needs.

grant insert (
  user_id,
  name,
  institution,
  type,
  opening_balance_cents,
  credit_limit_cents,
  interest_rate_bps
) on table public.accounts to authenticated;

grant update (
  name,
  institution,
  credit_limit_cents,
  interest_rate_bps,
  opening_balance_cents,
  is_archived
) on table public.accounts to authenticated;

-- ============================================================
-- categories -- column-scoped INSERT and UPDATE grants
-- ============================================================
-- Narrower still: a category is a name, a kind, and an archive flag.
-- `id` takes its default; `user_id` is INSERT-only for the same
-- ownership reason as accounts, and is not updatable.
--
-- `kind` *is* updatable, unlike accounts.type -- a category typed as
-- the wrong kind immediately after creation is an ordinary mistake to
-- fix, not a rewrite of history. What makes that safe is
-- guard_category_kind_change() below, which freezes the kind the
-- moment anything references the category.

grant insert (user_id, name, kind) on table public.categories to authenticated;

grant update (name, kind, is_archived) on table public.categories to authenticated;

-- ============================================================
-- Operation-specific RLS policies
-- ============================================================
-- (select auth.uid()) is wrapped exactly as the Phase 4 SELECT
-- policies wrap it, so Postgres evaluates it once per statement as an
-- initPlan rather than once per row scanned.
--
-- UPDATE takes both USING and WITH CHECK, and they are not redundant:
-- USING decides which existing rows the statement may touch, WITH
-- CHECK decides what those rows are allowed to look like afterwards.
-- With USING alone, an owned row could be updated into a shape that no
-- longer satisfies the predicate. `user_id` is not in the UPDATE grant,
-- so that is already unreachable through this role -- WITH CHECK is
-- stated anyway, because a policy that depends on a grant's column
-- list for its own correctness is one column-grant edit away from
-- being wrong.

create policy accounts_insert_own on public.accounts
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy accounts_update_own on public.accounts
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy categories_insert_own on public.categories
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy categories_update_own on public.categories
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ============================================================
-- accounts_guard_update -- BEFORE UPDATE on accounts
-- ============================================================
-- Three invariants that no GRANT, CHECK, or policy can express,
-- enforced in the database rather than in the mutation layer.
--
-- The mutation layer checks all three too, and gets better error
-- messages out of doing so -- but `authenticated` now holds a direct
-- UPDATE privilege on this table, and PostgREST is reachable from a
-- browser with nothing but a session token. Anything enforced only in
-- lib/data/mutations/** is enforced only for callers who choose to go
-- through it.
--
--   1. `type` is immutable. It is not in the UPDATE grant either, so
--      this is a backstop rather than the primary defense -- and a
--      deliberate one: the grant is a privilege a future migration
--      could widen in one line, while this fires regardless of who is
--      asking or what they were granted.
--
--   2. `opening_balance_cents` may change only while the account has
--      zero transactions. It is the *only* stored balance figure --
--      current balance is derived as opening + SUM(ledger) by the
--      account_balances view -- so editing it on an account with
--      history silently restates every balance that account has ever
--      reported, including ones already written into
--      net_worth_snapshots. Correcting a freshly created account's
--      starting figure is legitimate; retroactively moving the floor
--      under a ledger is the balance-adjustment/reconciliation
--      mechanism DEVELOPMENT_PLAN.md records as an undesigned
--      prerequisite, and this is what stops CP2 from accidentally
--      shipping a lossy version of it.
--
--   3. Archiving (false -> true) requires a derived balance of exactly
--      zero: opening_balance_cents + SUM(that account's transactions).
--      An archived account is excluded from net worth and from the
--      asset/liability totals (lib/finance/accounts.ts), so archiving
--      one that still holds money would make it silently vanish from
--      every total while its transactions stayed visible in history.
--      Unarchiving is always allowed -- it can only restore a figure
--      to the totals, never hide one, and refusing it would make a
--      mistaken archive permanent.
--
-- SECURITY INVOKER (the default, prosecdef = false), like every other
-- trigger function in this schema: the row aggregates below are
-- per-account, and the caller can only reach this trigger for a row RLS
-- already matched to them, so under FORCE RLS the invoker sees exactly
-- the transactions belonging to the account being updated. No elevated
-- context is needed, and taking one would hand a browser-reachable
-- write path a definer's privileges for no gain. `search_path = ''`
-- with every reference schema-qualified, as elsewhere in this schema.
--
-- BEFORE UPDATE only -- it never fires on INSERT or DELETE. That is
-- what keeps whole-user teardown valid: `delete from auth.users`
-- cascades through profiles into accounts as DELETE statements, which
-- this trigger does not see, so an owner whose accounts hold nonzero
-- balances is still fully deletable (proved in
-- supabase/tests/database/050-triggers-and-teardown.sql).
--
-- Error text names the account id and the violated rule only -- never
-- a balance, an amount, or a name. lib/data/db-errors.ts never quotes a
-- driver message onward, but a trigger's text is also read by humans in
-- logs.

create function public.accounts_guard_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_transaction_count integer;
  v_ledger_cents bigint;
begin
  if new.type is distinct from old.type then
    raise exception 'account %: type is immutable once the account exists', old.id
      using errcode = 'check_violation';
  end if;

  if new.opening_balance_cents is distinct from old.opening_balance_cents then
    select count(*) into v_transaction_count
    from public.transactions
    where account_id = old.id;

    if v_transaction_count > 0 then
      raise exception
        'account %: opening balance cannot change once the account has transactions', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  -- Only the false -> true transition is guarded. An update that leaves
  -- is_archived alone, or that unarchives, skips this entirely.
  if new.is_archived and not old.is_archived then
    select coalesce(sum(amount_cents), 0) into v_ledger_cents
    from public.transactions
    where account_id = old.id;

    -- NEW rather than OLD: one statement may legally set both columns
    -- (only on an account with no transactions, per rule 2 above), and
    -- the balance that matters is the one the account will have.
    if new.opening_balance_cents + v_ledger_cents <> 0 then
      raise exception 'account %: cannot archive while its derived balance is not zero', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.accounts_guard_update() from public, anon, authenticated;

create trigger accounts_guard_update
  before update on public.accounts
  for each row
  execute function public.accounts_guard_update();

-- ============================================================
-- guard_category_kind_change -- BEFORE UPDATE on categories
-- ============================================================
-- A category's kind may change only while the category is completely
-- unreferenced. Referenced means a row exists in any of
-- transactions.category_id, budgets.category_id, or bills.category_id
-- -- the three columns in this schema that point at a category.
--
-- Why this is a database invariant and not a mutation-layer rule:
-- `authenticated` now holds a direct UPDATE (kind) privilege on this
-- table. `kind` is what separates income from spending in every
-- rollup -- spendingByCategory, budget utilisation, the income/expense
-- split, the savings rate. Flipping it on a category that already has
-- history does not correct a mistake; it silently reclassifies months
-- of settled figures, and every chart that has already been read.
--
-- Rename and archive stay allowed for referenced categories, and that
-- is the point of scoping the check to `kind`: a category the owner has
-- stopped using still needs to be renameable and archivable, while its
-- historical rows keep resolving through it (getCategories() returns
-- archived rows deliberately -- filtering them out would blank the
-- labels on old transactions).
--
-- SECURITY INVOKER and search_path = '' for the same reasons as
-- accounts_guard_update above. `authenticated` holds SELECT on all
-- three referencing tables and under FORCE RLS sees exactly its own
-- rows in each -- which is the correct scope, since a foreign owner's
-- reference to this category is impossible (every one of those FKs is
-- composite and carries user_id).
--
-- BEFORE UPDATE only, so teardown is unaffected, exactly as above.

create function public.guard_category_kind_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.kind is distinct from old.kind then
    if exists (select 1 from public.transactions where category_id = old.id)
      or exists (select 1 from public.budgets where category_id = old.id)
      or exists (select 1 from public.bills where category_id = old.id)
    then
      raise exception 'category %: kind is immutable once the category is referenced', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_category_kind_change() from public, anon, authenticated;

create trigger categories_guard_kind_change
  before update on public.categories
  for each row
  execute function public.guard_category_kind_change();
