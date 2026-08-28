-- Phase 7 Checkpoint 3, migration M11a: transaction writes.
--
-- The second migration to grant `authenticated` anything beyond SELECT,
-- and the first to grant DELETE on anything at all. It opens exactly one
-- table -- transactions -- and widens nothing else: movements, budgets,
-- bills, bill_occurrences, goals, goal_contributions,
-- net_worth_snapshots and profiles keep the posture they have had since
-- Phase 4, and accounts/categories keep exactly the CP2 posture. That is
-- a checked fact, not a promise: supabase/tests/database/100-write-grants.sql
-- asserts the whole privilege matrix table by table and column by
-- column, for both application roles, and proves its own table list is
-- complete.
--
-- No earlier migration is edited. Everything here is additive, including
-- the one constraint that is dropped and immediately re-created with a
-- wider predicate (see "Constraints" below) -- the Phase 4 file that
-- originally created it is untouched.
--
-- Depends on 20260828120001_transaction_kind_adjustment.sql having
-- already committed: 'adjustment' is used below in a CHECK, in two
-- policy predicates and in a trigger body, and a label added by
-- `ALTER TYPE ... ADD VALUE` is unusable in the transaction that adds
-- it.
--
-- Five things land together and all five are required; none substitutes
-- for another (docs/rls-policies.md §2, §4, §5):
--
--   1. COLUMN-SCOPED INSERT/UPDATE grants. RLS filters rows, not
--      columns. A `FOR UPDATE` policy matching auth.uid() = user_id
--      would otherwise permit rewriting *every* column on a matched
--      row -- `user_id` and `movement_id` included -- which is the
--      difference between "correct the amount on my coffee" and "move
--      this row to another owner" or "adopt this row into a movement".
--   2. A table-level DELETE grant -- PostgreSQL has no column-level
--      DELETE -- narrowed to the right *rows* by policy instead.
--   3. OPERATION-SPECIFIC RLS policies, one per operation, role-
--      targeted, never FOR ALL. The UPDATE and DELETE predicates are
--      where "a movement leg is not an ordinary transaction" and "an
--      adjustment is not editable" are actually enforced.
--   4. Two CHECK constraints -- the sign rule widened for adjustments,
--      and adjustments-carry-no-category.
--   5. assert_transaction_refs() -- a BEFORE INSERT OR UPDATE trigger
--      carrying the four cross-row invariants no GRANT, CHECK or policy
--      can express, the most important of which is that a posted ledger
--      row may not be dated in the owner's future.
--
-- `anon` is not named in a single GRANT or policy below, and its Phase 4
-- posture (zero privileges on every user-financial table and view) is
-- untouched.

-- ============================================================
-- transactions -- column-scoped INSERT grant
-- ============================================================
-- `id` is granted here and nowhere else in this schema, and it is the
-- one deliberate departure from the CP2 convention of letting the
-- database choose every id. Ordinary transaction creation is the first
-- operation in this application where a double submit produces a *real
-- duplicate* -- two coffees, same amount, same day, both plausible --
-- so the create form generates one client-side UUID and posts it as the
-- row's id. A retry of the same logical submission therefore collides
-- with itself on the primary key (23505) instead of inserting a second
-- row, and lib/data/mutations/transactions.ts turns that collision into
-- either "this is my own identical row, the first attempt won" or a
-- refusal. Without a client-chosen id there is nothing for a retry to
-- collide *with*, and no amount of application code can recover the
-- property afterwards.
--
-- What granting `id` does not do: it is still scoped by the INSERT
-- policy's WITH CHECK, so a chosen id can only ever create a row owned
-- by the caller; and it is absent from the UPDATE grant, so an id can
-- be chosen once and never changed.
--
-- `user_id` is INSERT-only, as on accounts and categories: the
-- ownership predicate needs it assignable for a row to be insertable at
-- all, and leaving it out of UPDATE is what makes re-homing a row
-- unreachable rather than merely policy-checked.
--
-- `movement_id` is INSERT-only, and is granted now rather than in CP4
-- because the biconditional CHECK (a transfer/credit_card_payment row
-- *must* carry one) makes an INSERT grant that omits it unable to
-- express a movement leg at all. It confers nothing today: the
-- composite FK (movement_id, user_id) -> movements requires a movement
-- row to point at, `authenticated` has no INSERT grant on
-- public.movements, and validate_movement() rejects any movement that
-- does not end the transaction with exactly two balanced legs. CP4
-- opens movements; until then this column is grantable but unusable.
--
-- `created_at` is in neither list. It has a default, and a column absent
-- from a column-scoped INSERT grant simply takes it -- so omitting it
-- costs nothing and removes any way to backdate a row's entry order,
-- which is the `date DESC, created_at DESC, id ASC` ordering's tie-break
-- (docs/database-schema.md §17).

grant insert (
  id,
  user_id,
  account_id,
  date,
  merchant,
  kind,
  category_id,
  movement_id,
  amount_cents
) on table public.transactions to authenticated;

-- ============================================================
-- transactions -- column-scoped UPDATE grant
-- ============================================================
-- Every column a person can meaningfully correct after the fact, and
-- nothing else. The four exclusions are the design:
--
--   * `id` -- chosen once, at insert, by the idempotency key. An
--     updatable id would let a retry's collision be edited away.
--   * `user_id` -- an ownership reassignment, unreachable at the
--     privilege layer rather than merely refused by a policy.
--   * `movement_id` -- re-parenting a leg, or adopting an ordinary row
--     into a movement. validate_movement() would catch the resulting
--     invalid movement at COMMIT (020-movements.sql case 8 proves it),
--     but this makes the attempt impossible rather than merely futile.
--   * `created_at` -- see above.
--
-- `kind` *is* updatable: "I filed that as an expense, it was a refund"
-- is an ordinary correction. What keeps that safe is the UPDATE
-- policy's WITH CHECK, which refuses to let the new kind be
-- 'adjustment', plus assert_transaction_refs(), which re-checks the
-- category against the new kind.

grant update (
  account_id,
  date,
  merchant,
  kind,
  category_id,
  amount_cents
) on table public.transactions to authenticated;

-- ============================================================
-- transactions -- DELETE grant
-- ============================================================
-- The first DELETE grant in this schema. Accounts, categories, bills and
-- goals are all archived rather than removed, because each is a *label*
-- that historical rows resolve through -- archiving one keeps the past
-- readable. A transaction is not a label; it is the history. A mistyped
-- one has no correct archived state, and leaving it in place with a
-- "voided" flag would mean every balance, budget, KPI and chart in the
-- application growing a clause to exclude it. So transactions are
-- deleted outright.
--
-- PostgreSQL has no column-level DELETE privilege (only SELECT, INSERT,
-- UPDATE and REFERENCES can be column-scoped), so the narrowing is done
-- entirely by the policy's USING predicate below -- which is what keeps
-- movement legs out of reach.

grant delete on table public.transactions to authenticated;

-- ============================================================
-- Operation-specific RLS policies
-- ============================================================
-- (select auth.uid()) is wrapped exactly as every other policy in this
-- schema wraps it, so Postgres evaluates it once per statement as an
-- initPlan rather than once per row scanned.
--
-- `movement_id is null` appears in the UPDATE policy's USING *and* its
-- WITH CHECK, and in the DELETE policy's USING. It is the entire
-- mechanism by which a transfer/credit-card-payment leg is unreachable
-- from the ordinary transaction surface:
--
--   * A leg is invisible to UPDATE, so an ordinary edit matches zero
--     rows rather than half-rewriting a movement. Note this raises no
--     error -- an UPDATE whose target fails USING simply matches
--     nothing -- so 110-write-rls.sql proves it by re-reading the row
--     afterwards rather than by trusting the absence of a throw.
--   * A leg is invisible to DELETE, so one half of a movement can never
--     be removed leaving the other stranded. Deleting a movement
--     remains a CP4 operation performed on the *parent* row, which
--     cascades both legs (transactions_movement_fk is ON DELETE
--     CASCADE) and is the only correct way to do it.
--
-- It is deliberately absent from the INSERT policy: a leg has to be
-- insertable for CP4 to exist at all, and every other guarantee about
-- legs (exactly two, summing to zero, two accounts, matching kind, one
-- owner) is validate_movement()'s deferred job, which no per-row policy
-- could do.
--
-- `kind <> 'adjustment'` appears in the UPDATE policy's USING and WITH
-- CHECK, and the two halves refuse two different things:
--
--   * USING -- an existing adjustment row cannot be targeted. An
--     adjustment is the ledger's record of a reconciliation decision;
--     editing it would silently restate the balance that decision
--     produced, without the reconciliation that justified it.
--   * WITH CHECK -- an ordinary row cannot be turned into one. Without
--     it, the entry surface would be a two-step path to writing an
--     adjustment (create an expense, then retype it), which is exactly
--     the CP5-only capability CP3 is not supposed to ship.
--
-- Adjustment DELETE is deliberately *not* blocked. CP5's reconciliation
-- is delete-and-rewrite: a superseded adjustment must be removable, or
-- re-reconciling an account would stack adjustments on top of each
-- other forever.

create policy transactions_insert_own on public.transactions
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy transactions_update_own_ordinary on public.transactions
  for update to authenticated
  using (
    (select auth.uid()) = user_id
    and movement_id is null
    and kind <> 'adjustment'
  )
  with check (
    (select auth.uid()) = user_id
    and movement_id is null
    and kind <> 'adjustment'
  );

create policy transactions_delete_own_non_movement on public.transactions
  for delete to authenticated
  using (
    (select auth.uid()) = user_id
    and movement_id is null
  );

-- ============================================================
-- Constraints
-- ============================================================
-- transactions_sign_by_kind_ck is dropped and re-created rather than
-- amended in place -- PostgreSQL has no "alter constraint predicate" --
-- with every existing branch preserved verbatim and one branch added.
-- The Phase 4 migration that first created it is not touched; this is a
-- forward migration like any other.
--
-- What is preserved, deliberately and exactly:
--
--   * income/refund >= 0, expense <= 0. Unchanged.
--   * Zero remains legal for ordinary rows. The check is non-strict on
--     purpose: a legal seeded row has amount_cents = 0 on an expense
--     (030-constraints.sql asserts it), and a genuinely zero-amount
--     transaction -- a fully discounted order, a fee that was waived --
--     is a real thing a person records.
--   * transfer/credit_card_payment stay unconstrained *here*, because
--     their rule is directional per leg and lives in
--     transactions_movement_nonzero_ck plus validate_movement().
--
-- What is added: 'adjustment' is unconstrained in sign. That is not
-- laxity, it is the definition -- a reconciliation adjustment is
-- whatever signed delta reconciles a derived balance to a real one, and
-- a rule guessing its direction now would be a rule CP5 has to fight.
-- Its integrity comes from elsewhere: it cannot be created or edited
-- through the ordinary surface at all (the policies above), and it must
-- carry no category (below).

alter table public.transactions
  drop constraint transactions_sign_by_kind_ck;

alter table public.transactions
  add constraint transactions_sign_by_kind_ck check (
    (kind in ('income', 'refund') and amount_cents >= 0)
    or (kind = 'expense' and amount_cents <= 0)
    or (kind in ('transfer', 'credit_card_payment'))
    or (kind = 'adjustment')
  );

-- An adjustment is a correction to an account's *balance*, not a record
-- of consumption, so it belongs to no spending or income category. If it
-- carried one it would land in spendingByCategory, in budget
-- utilisation, and in the income/expense split -- silently attributing a
-- reconciliation difference to whatever category happened to be picked.
--
-- One-directional, like transactions_movement_no_category_ck: an
-- ordinary row is still legally allowed to have no category.
alter table public.transactions
  add constraint transactions_adjustment_no_category_ck check (
    kind <> 'adjustment' or category_id is null
  );

-- ============================================================
-- assert_transaction_refs -- BEFORE INSERT OR UPDATE on transactions
-- ============================================================
-- Four cross-row invariants, in the database rather than only in the
-- mutation layer. `authenticated` now holds direct INSERT, UPDATE and
-- DELETE privileges on this table, and PostgREST is reachable from a
-- browser with nothing but a session token -- so anything enforced only
-- in lib/data/mutations/** is enforced only for callers who choose to go
-- through it. The mutation layer checks all four too, and gets better
-- error messages out of doing so; neither layer is redundant.
--
-- 1. NO POSTED LEDGER ROW MAY BE DATED IN THE OWNER'S FUTURE.
--
--    This table is the ledger of what has happened. A future-dated row
--    is not a transaction, it is an intention -- and this schema already
--    has a place for those: bills and their scheduled occurrences
--    (docs/database-schema.md §13). Allowing one here would corrupt
--    every "this month" figure in the application the moment it was
--    entered: monthlyIncome/monthlySpending/monthlyCashFlow bucket by
--    calendar month with no upper bound, account_balances sums the
--    entire ledger with no date predicate, and the net-worth snapshot
--    writer would capture a balance that includes money not yet moved.
--
--    The ceiling is `(now() at time zone <the owner's timezone>)::date`,
--    and the timezone comes from the owner's own profiles row -- the
--    same source lib/data/clock.ts reads for getToday(). There is no
--    server-UTC shortcut here, and that is the whole point: for an owner
--    in Auckland, UTC "today" is yesterday for most of their waking day,
--    so a UTC ceiling would reject a transaction they are entering right
--    now, on the date their own calendar shows. For an owner in Los
--    Angeles the error runs the other way, accepting a row dated
--    tomorrow for several hours each night. 135-posted-ledger.sql
--    contains a case built specifically to fail if this is ever
--    rewritten to compare against a UTC date.
--
--    A profile this statement cannot see raises nothing and skips the
--    ceiling, deferring to the layer that already owns that case -- the
--    same treatment rules 2 and 3 give an invisible account or category,
--    and for the same reason: taking the case over here would change the
--    error code of a situation the ownership and RLS suites already pin,
--    without refusing anything they do not already refuse.
--
--    That is not a hole, and the argument is short enough to state in
--    full. There are exactly three ways to reach this trigger:
--
--      * As `authenticated`, inserting. `profiles_select_own` makes
--        exactly one profile visible -- the caller's own -- and
--        `transactions_insert_own`'s WITH CHECK refuses any row whose
--        user_id is not that same uid. So either the profile is visible
--        and the ceiling is enforced, or the row is refused by RLS.
--      * As `authenticated`, updating. `transactions_update_own_ordinary`
--        USING already restricted the statement to the caller's own
--        rows, so the profile is visible by construction.
--      * As the migration owner or a superuser, where RLS is bypassed
--        and every profile is visible -- so the ceiling is always
--        enforced, which is what makes it apply to the seed.
--
--    And a row with no profiles row at all cannot commit regardless:
--    transactions.user_id -> profiles.id is NOT DEFERRABLE.
--
-- 2. THE ACCOUNT MAY NOT BE ARCHIVED.
--
--    Cross-*owner* account references are not this trigger's job and are
--    deliberately not checked here: transactions_account_fk is a
--    composite (account_id, user_id) -> accounts (id, user_id) foreign
--    key, which makes a foreign account structurally impossible
--    (docs/rls-policies.md §6, proved in 040-ownership.sql). This
--    trigger therefore scopes its lookup to (id, user_id) and, if it
--    finds nothing, raises nothing -- letting the deferred FK produce
--    its own 23503 exactly as it does today. Raising here instead would
--    change the error code of a case the ownership suite already pins.
--
--    What it adds is the archived check. An archived account is excluded
--    from net worth and from the asset/liability totals
--    (lib/finance/accounts.ts), and CP2's accounts_guard_update() only
--    lets an account be archived once its derived balance is exactly
--    zero. Posting into one afterwards would push a nonzero balance into
--    an account that every total ignores -- money that exists in the
--    ledger and in no summary. "Unarchive it first" is the rule.
--
-- 3. CATEGORY RULES, when a category is present at all.
--
--    Uncategorized ordinary rows stay legal -- that is an existing,
--    deliberate property of this schema (030-constraints.sql) and this
--    trigger does not touch it.
--
--    An archived category is refused for the same reason as an archived
--    account: archiving is how a person says "stop offering me this",
--    and honouring that only in the picker means a stale form or a
--    hand-crafted request quietly reopens it. Existing rows keep
--    resolving through it, which is why getCategories() still returns
--    archived rows.
--
--    Kind agreement -- income needs an income category, expense and
--    refund need an expense category -- is what keeps every rollup
--    coherent. A refund takes an *expense* category deliberately: it
--    reduces that category's spend (lib/finance/transactions.ts
--    countsAsSpending), it is not income.
--
--    As with the account, a category the lookup cannot see produces no
--    error here; the composite FK owns that case.
--
-- 4. AN ADJUSTMENT CARRIES NO CATEGORY, and neither does a movement
--    leg. Both are also CHECK constraints
--    (transactions_adjustment_no_category_ck,
--    transactions_movement_no_category_ck) and both raise the same
--    SQLSTATE from either layer, so the existing constraint tests are
--    unaffected by which fires first.
--
-- MOVEMENT LEGS ARE NOT EXEMPT from rules 1 and 2, and that is
-- forward-looking rather than incidental: CP4 inserts transfer and
-- credit-card-payment legs through this same table, and a movement dated
-- tomorrow or landing in an archived account would corrupt exactly the
-- same figures as an ordinary row doing it. Writing the trigger over
-- every row now means CP4 inherits the protection instead of having to
-- remember it.
--
-- SECURITY INVOKER (the default, prosecdef = false) with
-- search_path = '', like every other trigger function in this schema. No
-- elevated context is needed: under FORCE RLS the invoker sees its own
-- profile, its own accounts and its own categories, which is exactly the
-- scope every lookup here wants, and taking a definer's privileges would
-- hand a browser-reachable write path capabilities it has no use for.
--
-- BEFORE INSERT OR UPDATE only -- never DELETE -- so whole-user teardown
-- stays valid: `delete from auth.users` cascades through profiles into
-- transactions as DELETE statements this trigger never sees
-- (050-triggers-and-teardown.sql).
--
-- Error text names the row id, the referenced id, and the violated rule.
-- Never an amount, never a merchant, never a balance, never a name --
-- lib/data/db-errors.ts never quotes a driver message onward, but a
-- trigger's text is also read by humans in logs.

create function public.assert_transaction_refs()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_timezone text;
  v_today date;
  v_account_archived boolean;
  v_category_kind public.category_kind;
  v_category_archived boolean;
begin
  -- ---------- 1. Posted-date ceiling, in the owner's timezone ----------
  select p.timezone into v_timezone
  from public.profiles p
  where p.id = new.user_id;

  -- Not visible to this statement: RLS or the NOT DEFERRABLE FK already
  -- refuses this write (see rule 1's note above). Deferring rather than
  -- raising keeps their error codes intact.
  if v_timezone is not null then
    -- now() is timestamptz; `at time zone <name>` renders it as local
    -- wall time in that zone, and ::date takes that zone's calendar day.
    -- No server-local or UTC date is constructed anywhere in this
    -- expression.
    v_today := (now() at time zone v_timezone)::date;

    if new.date > v_today then
      raise exception 'transaction %: date is later than the owner''s current calendar day', new.id
        using errcode = 'check_violation';
    end if;
  end if;

  -- ---------- 2. The account may not be archived ----------
  select a.is_archived into v_account_archived
  from public.accounts a
  where a.id = new.account_id and a.user_id = new.user_id;

  -- `is true` rather than a bare boolean test: not-found leaves the
  -- variable null, and null must fall through to the composite FK rather
  -- than be treated as either archived or active.
  if v_account_archived is true then
    raise exception 'transaction %: account % is archived', new.id, new.account_id
      using errcode = 'check_violation';
  end if;

  -- ---------- 3 & 4. Category rules ----------
  if new.category_id is not null then
    if new.kind = 'adjustment' then
      raise exception 'transaction %: an adjustment carries no category', new.id
        using errcode = 'check_violation';
    end if;

    if new.movement_id is not null
       or new.kind in ('transfer', 'credit_card_payment') then
      raise exception 'transaction %: a movement leg carries no category', new.id
        using errcode = 'check_violation';
    end if;

    select c.kind, c.is_archived into v_category_kind, v_category_archived
    from public.categories c
    where c.id = new.category_id and c.user_id = new.user_id;

    -- Not found: the composite FK owns that case (see rule 2's note).
    if v_category_kind is not null then
      if v_category_archived then
        raise exception 'transaction %: category % is archived', new.id, new.category_id
          using errcode = 'check_violation';
      end if;

      if new.kind = 'income' and v_category_kind <> 'income' then
        raise exception 'transaction %: income requires an income category', new.id
          using errcode = 'check_violation';
      end if;

      if new.kind in ('expense', 'refund') and v_category_kind <> 'expense' then
        raise exception 'transaction %: % requires an expense category', new.id, new.kind
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.assert_transaction_refs() from public, anon, authenticated;

create trigger transactions_assert_refs
  before insert or update on public.transactions
  for each row
  execute function public.assert_transaction_refs();
