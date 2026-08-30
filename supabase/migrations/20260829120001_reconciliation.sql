-- Phase 7 Checkpoint 5, migration M11c: account reconciliation.
--
-- One function, `public.reconcile_account`. No new table is opened, no
-- grant is widened, and no earlier migration is edited. That is the
-- headline: reconciliation is a *new operation over an existing
-- privilege*, not a new privilege.
--
-- CP3 already granted `authenticated` a column-scoped INSERT on
-- transactions covering `kind`, and CP3's own constraints already made
-- `adjustment` a legal stored kind (transactions_sign_by_kind_ck's
-- `or (kind = 'adjustment')` branch, unconstrained in sign;
-- transactions_adjustment_no_category_ck, which forbids a category on
-- one). What CP3 deliberately withheld was a *path* to writing one: the
-- ordinary surface's validation types its kind as
-- OrdinaryTransactionKind, and `transactions_update_own_ordinary`
-- refuses both to target an adjustment and to produce one. This
-- migration adds the one path, and it is a function rather than a
-- PostgREST statement for a reason given in full below.
--
-- Everything else keeps exactly the posture it has had:
-- supabase/tests/database/100-write-grants.sql still asserts the whole
-- privilege matrix table by table and column by column, and it is
-- unchanged by this file. `anon` is not named in a single GRANT below.
--
-- ============================================================
-- Why a function, given that the INSERT grant already exists
-- ============================================================
--
-- A reconciliation is not "insert an adjustment". It is:
--
--   delta := desired_internal_balance - (opening + SUM(ledger))
--
-- and *then* an insert of exactly `delta`, or of nothing at all when
-- `delta` is zero. The subtraction is the operation; the row is its
-- residue. Computing the current balance in the client and posting the
-- difference would mean the number written to the ledger was chosen by
-- the caller from a balance it read at some earlier moment — so a
-- transaction entered in another tab between the read and the post would
-- silently leave the account reconciled to the wrong figure, with an
-- adjustment row that looks perfectly well-formed and is simply wrong.
--
-- Deriving the delta inside the database, in the same statement that
-- writes the row, removes that window: the balance the delta is computed
-- from is the balance at the instant of the write.
--
-- The zero case matters for the same reason. "Nothing to correct" is a
-- successful reconciliation, and it must write no row -- a stream of
-- zero-amount adjustments would be noise in the one place a person goes
-- to see what actually happened to an account.
--
-- ============================================================
-- SECURITY INVOKER, and it genuinely does not need more
-- ============================================================
--
-- SECURITY INVOKER (the default; prosecdef = false), like
-- create_movement/replace_movement and like every other function in this
-- schema except the three Phase 4 system writers. The caller already
-- holds every privilege this body uses -- SELECT on accounts and
-- transactions, INSERT on transactions -- and under FORCE RLS the
-- invoker sees exactly its own accounts and its own ledger, which is the
-- correct scope for both reads here. A definer's context would not add a
-- check; it would remove the RLS that currently backs every statement
-- below.
--
-- The owner is derived from auth.uid() and is never a parameter. There
-- is no p_user_id here and there must never be one.
--
-- ============================================================
-- What this function checks, and what it leaves to the database
-- ============================================================
--
-- Checked here:
--
--   1. An authenticated caller.
--   2. An account that exists and belongs to the caller -- and the
--      lookup is needed anyway, for the opening balance the derived
--      balance is built from.
--   3. That the account is not archived. Also enforced by
--      assert_transaction_refs() on the insert below; checked first so
--      the refusal names the rule rather than arriving as a trigger's
--      check violation on a row that was never going to be written.
--   4. That the desired balance is inside the safe-integer range the
--      `Cents` brand guarantees on the TypeScript side. A bigint
--      subtraction that overflows raises 22003 rather than wrapping, so
--      this is about refusing a figure the DTO could never carry, not
--      about arithmetic safety.
--
-- Left to the database, on purpose, because it already owns them:
--
--   * THE POSTED-DATE CEILING. `p_as_of` is not compared to anything
--     here. assert_transaction_refs() (CP3) refuses any row dated later
--     than the owner's own calendar day, computed from
--     `(now() at time zone profiles.timezone)::date` -- never server
--     UTC. Re-deriving that ceiling here would mean two expressions that
--     have to agree forever, and the trigger's is the one that also
--     covers every other write path.
--   * "AN ADJUSTMENT CARRIES NO CATEGORY" --
--     transactions_adjustment_no_category_ck and
--     assert_transaction_refs() both refuse one. The insert below writes
--     an explicit null regardless, so the rule is visible at the
--     statement.
--   * "AN ADJUSTMENT CARRIES NO MOVEMENT" --
--     transactions_movement_biconditional_ck. Written as an explicit
--     null for the same reason.
--
-- ============================================================
-- Idempotency, without an idempotency key
-- ============================================================
--
-- CP3 and CP4 both needed a client-minted UUID, because two identical
-- coffees on the same day are a legitimate pair of rows and nothing
-- about a submission's contents could distinguish a duplicate from a
-- genuine second one.
--
-- Reconciliation does not have that problem, and the reason is
-- structural rather than lucky: the second submission of the *same*
-- reconciliation computes its delta against a balance the first
-- submission already corrected, so the delta is zero and no row is
-- written. A double-click reconciles once and then reports "already
-- reconciled". There is nothing to key, nothing to compare, and no
-- second store to keep in step.
--
-- ============================================================
-- The return value
-- ============================================================
--
-- jsonb, so the caller can tell the two successful outcomes apart --
-- "an adjustment was created" and "the balance already matched" -- and
-- so the created row's id is available without the caller having to
-- guess at it. `delta_cents` is the caller's own figure for its own
-- account, so returning it leaks nothing; it is nonetheless absent from
-- every `raise` below, because a raise's text is read by humans in logs
-- and by lib/data/db-errors.ts's `cause`.

create function public.reconcile_account(
  p_account_id uuid,
  p_as_of date,
  p_desired_balance_cents bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Mirrors Number.MAX_SAFE_INTEGER: the bound `toCents()` enforces on
  -- every value crossing the DB->TS boundary, restated here so a figure
  -- the domain could not represent is refused before it is stored rather
  -- than after it is read back.
  c_max_safe_cents constant bigint := 9007199254740991;
  v_owner_id uuid := (select auth.uid());
  v_is_archived boolean;
  v_opening_balance_cents bigint;
  v_current_balance_cents bigint;
  v_delta_cents bigint;
  v_adjustment_id uuid;
begin
  if v_owner_id is null then
    raise exception 'reconcile_account requires an authenticated caller'
      using errcode = 'invalid_authorization_specification';
  end if;

  if p_account_id is null or p_as_of is null or p_desired_balance_cents is null then
    raise exception 'reconcile_account: account, date and target balance are all required'
      using errcode = 'check_violation';
  end if;

  if abs(p_desired_balance_cents) > c_max_safe_cents then
    raise exception 'reconcile_account: target balance is outside the representable range'
      using errcode = 'numeric_value_out_of_range';
  end if;

  -- ---------- The account, scoped to (id, user_id) ----------
  -- Ownership is asserted explicitly on top of RLS, exactly as every
  -- other lookup in this schema does it. A foreign account is invisible
  -- through `accounts_select_own` anyway, so this raise is about
  -- producing a refusal rather than a silent "no such account".
  select a.is_archived, a.opening_balance_cents
  into v_is_archived, v_opening_balance_cents
  from public.accounts a
  where a.id = p_account_id and a.user_id = v_owner_id;

  if v_is_archived is null then
    raise exception 'reconcile_account: account % is not available', p_account_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_is_archived then
    raise exception 'reconcile_account: account % is archived', p_account_id
      using errcode = 'check_violation';
  end if;

  -- ---------- The derived balance, as public.account_balances defines it ----------
  -- opening_balance_cents + SUM(every one of that account's transaction
  -- amounts), with no date predicate -- the same expression the
  -- `account_balances` view computes and `lib/finance/accounts.ts`
  -- reasons about. Movement legs and earlier adjustments are included,
  -- because both move the balance.
  --
  -- Read from the base table rather than through the view so this
  -- function depends on the column it actually needs rather than on a
  -- view definition that exists for the read path's convenience.
  select v_opening_balance_cents + coalesce(sum(t.amount_cents), 0)
  into v_current_balance_cents
  from public.transactions t
  where t.account_id = p_account_id and t.user_id = v_owner_id;

  v_delta_cents := p_desired_balance_cents - v_current_balance_cents;

  -- ---------- Nothing to correct ----------
  -- A logical success that writes no row. See "Idempotency" above: this
  -- is also what makes a resubmitted reconciliation harmless.
  if v_delta_cents = 0 then
    return jsonb_build_object(
      'created', false,
      'adjustment_id', null,
      'delta_cents', 0
    );
  end if;

  -- ---------- The adjustment ----------
  -- `id` and `created_at` take their defaults. The merchant label is a
  -- fixed, developer-authored string rather than anything derived from
  -- the amount, the account or the caller: an adjustment is not a
  -- transaction with a counterparty, and free text on a row a person
  -- cannot edit would be a field with no owner.
  --
  -- `kind` is 'adjustment' and the sign of `amount_cents` is whatever
  -- the correction requires -- which is exactly why CP3 widened
  -- transactions_sign_by_kind_ck with an unconstrained adjustment
  -- branch. lib/finance/transactions.ts counts the row as neither
  -- spending nor income, so it moves the balance and net worth without
  -- appearing in a single economic total.
  insert into public.transactions
    (user_id, account_id, date, merchant, kind, category_id, movement_id, amount_cents)
  values
    (v_owner_id, p_account_id, p_as_of, 'Balance adjustment', 'adjustment', null, null, v_delta_cents)
  returning id into v_adjustment_id;

  return jsonb_build_object(
    'created', true,
    'adjustment_id', v_adjustment_id,
    'delta_cents', v_delta_cents
  );
end;
$$;

revoke execute on function public.reconcile_account(uuid, date, bigint)
  from public, anon;

grant execute on function public.reconcile_account(uuid, date, bigint)
  to authenticated;
