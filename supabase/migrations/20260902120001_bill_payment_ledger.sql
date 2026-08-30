-- Phase 8 Checkpoint 1: a paid bill occurrence may become a real ledger row.
--
-- This migration changes one *stated* invariant and nothing else. Through CP7,
-- "bill tracking creates no ledger activity, ever" was the load-bearing
-- property of the whole bill domain. It is now narrower, and the new statement
-- is exact:
--
--     A SCHEDULED occurrence is a projection and writes nothing.
--     A SKIPPED occurrence writes nothing.
--     Creating, editing, archiving or unarchiving a BILL writes nothing.
--     Only the scheduled -> paid transition may write a ledger row, and only
--     when the bill names a usable account and the owner did not link an
--     existing transaction instead.
--
-- Everything CP7 said about *what may not be rewritten* is untouched:
-- `bill_occurrences.amount_cents` and `due_date` are still absent from every
-- grant, `bills` still has no DELETE, `bill_occurrences` still has no INSERT
-- and no DELETE for `authenticated`, and the occurrence state machine is
-- unchanged.
--
-- `anon` is not named in a single GRANT or policy below.
--
-- ============================================================
-- The problem this solves, and the shape the solution has to take
-- ============================================================
--
-- Marking a bill paid and then separately typing the same expense is the one
-- piece of double-entry this application asked a person to do by hand. Doing
-- it for them is only correct if four things hold at once:
--
--   1. The occurrence's status change and the ledger row commit together, or
--      neither does. A half-finished settlement -- "paid" with no transaction,
--      or an orphan expense with no occurrence pointing at it -- is worse than
--      the manual workflow it replaces.
--   2. A retry, a double click, or a lost response never produces a second
--      transaction.
--   3. The system can tell a row it generated apart from a row the person
--      wrote and merely linked -- because unmarking must be able to remove the
--      first and must never remove the second.
--   4. The generated row is an ordinary expense in every respect: negative in
--      storage, counted in monthly spending and in its category's budget,
--      carrying no movement, and deletable/editable by its owner under the
--      ordinary rules once it is no longer linked.
--
-- (1) forces a function: PostgREST issues one statement per request in its own
-- transaction, so an INSERT into `transactions` and an UPDATE of
-- `bill_occurrences` cannot be one commit from two calls. That is the same
-- argument CP4's movement RPCs and CP7's bill RPCs make, and it lands in the
-- same place: two SECURITY INVOKER functions, `public.settle_bill_occurrence`
-- and `public.unsettle_bill_occurrence`, running under the caller's own
-- privileges and the caller's own RLS.
--
-- (3) forces a stored provenance fact, and the interesting question is how to
-- make it unforgeable. See `transaction_origin` below.

-- ============================================================
-- bill_payment_origin -- how an occurrence came to reference a transaction
-- ============================================================
-- Two values, and the distinction is the whole point of the checkpoint:
--
--   'linked'    -- the owner chose one of their own existing transactions.
--                  The application did not create it, does not own it, and
--                  must never delete it.
--   'generated' -- the application created that transaction, in the same
--                  transaction as the settlement, on the owner's behalf. It is
--                  safely reversible with the occurrence, because nothing else
--                  in the ledger has ever had a reason to point at it.
--
-- A separate enum rather than a boolean because "not linked at all" is a third
-- state and is expressed by NULL -- a paid occurrence with no transaction is
-- still legal and still ordinary (a bill paid from an account this dashboard
-- does not track).

create type public.bill_payment_origin as enum ('linked', 'generated');

alter table public.bill_occurrences
  add column transaction_origin public.bill_payment_origin null;

-- Existing links are, by definition, ones a person made by hand: nothing could
-- generate one before this migration. Backfilling them as 'linked' is both
-- correct and the conservative direction -- 'linked' is the value that makes
-- `unsettle_bill_occurrence` leave the transaction alone.
--
-- Runs *before* the CHECK below, because a paid occurrence that already
-- references a transaction would violate it otherwise.
update public.bill_occurrences
set transaction_origin = 'linked'
where transaction_id is not null;

-- Biconditional, in the spirit of transactions_movement_biconditional_ck:
-- provenance exists exactly when there is a reference to have provenance
-- *for*. It also means the existing status-consistency CHECK
-- (scheduled/skipped carry no transaction_id) transitively forbids an origin
-- on a non-paid row, with no second expression to keep in step.
alter table public.bill_occurrences
  add constraint bill_occurrences_transaction_origin_ck check (
    (transaction_id is null) = (transaction_origin is null)
  );

-- The column joins the existing three-column UPDATE grant. It has to: both
-- functions below are SECURITY INVOKER and therefore write as the caller.
-- What stops a hand-crafted request from claiming 'generated' over someone's
-- hand-written transaction -- and then deleting it by unmarking -- is not the
-- grant but `guard_bill_occurrence_transition()`'s provenance rule, which is
-- unforgeable for a reason set out there.
grant update (transaction_origin) on table public.bill_occurrences to authenticated;

-- ============================================================
-- guard_bill_occurrence_transition -- CP7's trigger, plus provenance
-- ============================================================
-- Replaced rather than amended: PostgreSQL has no "alter function body in
-- place" that would let the state machine below be edited in isolation, and
-- the CP7 migration that first created it is not touched. Every rule it
-- already carried is preserved verbatim -- the immutable-column list, the four
-- supported transitions, the idempotent same-status update, and the paid_on
-- ceiling in the owner's own timezone -- and exactly one rule is added.
--
-- ## The provenance rule, and why it cannot be forged
--
-- `transaction_origin = 'generated'` is a claim that *this application* wrote
-- the referenced transaction as part of settling this occurrence. The database
-- can verify that claim exactly, with no trust in the caller:
--
--     the referenced transaction's created_at must equal now()
--
-- `now()` is `transaction_timestamp()` -- fixed for the whole database
-- transaction -- and `transactions.created_at` takes the identical `now()`
-- default. So the equality holds if and only if the row was inserted by the
-- very transaction performing this update, and fails for every row that
-- existed beforehand.
--
-- It is unforgeable because `created_at` is absent from `authenticated`'s
-- INSERT grant *and* from its UPDATE grant on `transactions`
-- (20260828120002_transaction_writes.sql, asserted column by column in
-- 100-write-grants.sql). There is no statement available to this role that can
-- set, backdate or forward-date that column, so there is no way to manufacture
-- a row that satisfies the test without genuinely creating it here and now.
--
-- The consequence worth stating plainly: an owner who hand-crafts a request
-- naming one of their own older transactions can only ever mark it 'linked',
-- and `unsettle_bill_occurrence` never deletes a 'linked' transaction. The
-- "manual transaction silently deleted" failure is therefore not merely
-- avoided by application code -- it is not expressible.
--
-- Checked only on the *transition into* a generated reference, never on every
-- update: a later edit of `paid_on` on an already-generated occurrence would
-- otherwise be refused because the transaction it points at was, correctly,
-- created earlier.
--
-- SECURITY INVOKER with `search_path = ''`, exactly as before. The
-- `transactions` lookup runs as the caller under FORCE RLS, which is the right
-- scope: a reference the caller cannot see is the composite FK's business
-- (`bill_occurrences_transaction_fk`), not this trigger's, and is treated the
-- same way every other lookup in this schema treats a not-found row.

create or replace function public.guard_bill_occurrence_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_timezone text;
  v_today date;
  v_created_at timestamptz;
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
      'bill occurrence %: only status, paid_on, transaction_id and transaction_origin may be updated', old.id
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

  -- ---------- Provenance: 'generated' must be earned, not declared ----------
  if new.transaction_origin = 'generated'
     and (
       old.transaction_origin is distinct from 'generated'
       or old.transaction_id is distinct from new.transaction_id
     )
  then
    select t.created_at into v_created_at
    from public.transactions t
    where t.id = new.transaction_id and t.user_id = new.user_id;

    -- Not visible: bill_occurrences_transaction_fk owns that case, exactly as
    -- assert_transaction_refs() defers an invisible account to its own FK.
    if v_created_at is not null and v_created_at <> now() then
      raise exception
        'bill occurrence %: a generated payment must be created by the same transaction that records it', new.id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_bill_occurrence_transition()
  from public, anon, authenticated;

-- ============================================================
-- public.settle_bill_occurrence -- mark paid, and (maybe) post the expense
-- ============================================================
-- SECURITY INVOKER (the default, prosecdef = false), like CP4's movement RPCs,
-- CP5's reconcile_account and CP7's three bill RPCs. The caller already holds
-- every privilege this body uses -- SELECT on bill_occurrences/bills/accounts/
-- categories/transactions, INSERT on transactions, and the four-column UPDATE
-- on bill_occurrences -- and under FORCE RLS the invoker sees exactly its own
-- rows. A definer's context would not add a check here; it would remove the
-- RLS that backs every statement below.
--
-- The owner comes from `auth.uid()` and is never a parameter.
--
-- ============================================================
-- The four outcomes, and how each is decided
-- ============================================================
--
--   * ALREADY PAID -- the occurrence is already `paid`. Nothing is written at
--     all and success is reported. This is the idempotency guarantee, and it
--     is checked *before* anything is inserted, so a retry after a lost
--     response, a double-clicked button, and a replayed request all land here.
--     It is also why "correct the paid date" is unmark-then-mark-again rather
--     than a second mark: a second mark is defined to be a no-op.
--   * LINKED -- `p_transaction_id` names one of the owner's existing
--     transactions. Nothing about that transaction is read, altered, checked
--     for kind, amount or date, or created. The occurrence records the
--     reference with origin 'linked'. No ledger row moves.
--   * GENERATED -- no transaction was named, and the bill names an account
--     that is not archived. One ordinary expense is inserted and the
--     occurrence records it with origin 'generated'.
--   * STATUS ONLY -- no transaction was named and the bill has no usable
--     account. The occurrence is marked paid with no reference at all, exactly
--     as it was through CP7.
--
-- ## Why an unusable account is a fallback rather than a refusal
--
-- `assert_transaction_refs()` refuses a ledger row in an archived account, and
-- rightly: archiving requires a derived balance of exactly zero and
-- lib/finance/accounts.ts excludes archived accounts from every total, so a
-- row posted into one would exist in the ledger and in no summary. But
-- refusing the *settlement* over it would leave a person unable to record that
-- they paid a bill, because of a bookkeeping detail about an account they have
-- already stopped using. So an archived account means "not enough usable
-- information to post a ledger row", which is the same answer as no account at
-- all -- and /bills says which of the four outcomes a given Mark paid will
-- produce, before it is pressed, rather than after.
--
-- ## The category is carried only when it can legally label an expense
--
-- A bill's category kind is deliberately unconstrained (CP7's assert_bill_refs
-- says why: a bill's category is a label on an obligation, not a statement
-- that the row is spending). An expense transaction's category is *not*
-- unconstrained -- assert_transaction_refs() requires an active expense
-- category. When the bill's category cannot satisfy that, the generated row is
-- created uncategorized rather than the settlement being refused: an
-- uncategorized expense is legal, visible, and one edit away from correct,
-- while a refusal is a dead end. `category_applied` in the return value says
-- which happened.
--
-- ## Idempotency, in three independent layers
--
--   1. The already-paid short circuit above -- the one that actually fires for
--      every realistic retry.
--   2. `p_generated_transaction_id`, a client-minted UUID used verbatim as the
--      new row's `id`, exactly as CP3/CP4/CP6/CP7 do it. A torn retry that
--      somehow reaches the INSERT collides with itself on the primary key
--      (23505) instead of writing a second expense.
--   3. The UPDATE below carries `status = 'scheduled'` in its own WHERE and
--      the row count is checked. Two genuinely simultaneous requests both read
--      `scheduled`; the second blocks on the first's row lock, re-evaluates
--      after it commits, matches zero rows, and raises -- rolling back its own
--      inserted transaction with it. There is no window in which two
--      transactions settle one occurrence.
--
-- ## Merchant
--
-- The bill's own name, verbatim. A recurring bill is named for its payee
-- ("Rent", "Vodafone"), so anything decorated around it would read worse in
-- the ledger than the plain thing. It is not free text from the settlement
-- form: no merchant is a parameter of this function.

create function public.settle_bill_occurrence(
  p_occurrence_id uuid,
  p_paid_on date,
  p_transaction_id uuid,
  p_generated_transaction_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_status public.bill_occurrence_status;
  v_bill_id uuid;
  v_amount_cents bigint;
  v_existing_transaction_id uuid;
  v_bill_name text;
  v_bill_account_id uuid;
  v_bill_category_id uuid;
  v_account_archived boolean;
  v_category_kind public.category_kind;
  v_category_archived boolean;
  v_category_id uuid := null;
  v_link_id uuid := null;
  v_origin public.bill_payment_origin := null;
  v_generated boolean := false;
  v_updated integer;
begin
  if v_owner_id is null then
    raise exception 'settle_bill_occurrence requires an authenticated caller'
      using errcode = 'invalid_authorization_specification';
  end if;

  if p_occurrence_id is null or p_paid_on is null then
    raise exception 'settle_bill_occurrence: occurrence and paid date are both required'
      using errcode = 'check_violation';
  end if;

  -- ---------- The occurrence, scoped to (id, user_id) ----------
  -- Ownership is asserted explicitly on top of RLS, as every other lookup in
  -- this schema does it. A foreign occurrence is invisible through
  -- `bill_occurrences_select_own` anyway; this raise is about producing a
  -- refusal rather than a silent "nothing happened".
  select o.status, o.bill_id, o.amount_cents, o.transaction_id
  into v_status, v_bill_id, v_amount_cents, v_existing_transaction_id
  from public.bill_occurrences o
  where o.id = p_occurrence_id and o.user_id = v_owner_id;

  if v_status is null then
    raise exception 'settle_bill_occurrence: occurrence % is not available', p_occurrence_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_status = 'skipped' then
    raise exception 'settle_bill_occurrence: occurrence % is skipped', p_occurrence_id
      using errcode = 'check_violation';
  end if;

  -- ---------- Already paid: the idempotent no-op ----------
  if v_status = 'paid' then
    return jsonb_build_object(
      'settled', false,
      'already_paid', true,
      'ledger_changed', false,
      'generated', false,
      'category_applied', false,
      'transaction_id', v_existing_transaction_id
    );
  end if;

  if p_transaction_id is not null then
    -- ---------- LINKED ----------
    -- The transaction is checked for existence and ownership and for nothing
    -- else. No rule about its kind, amount, date or account: a bill is an
    -- expected obligation and a transaction is what happened, and matching
    -- figures is explicitly not how a payment is identified (CP7).
    perform 1
    from public.transactions t
    where t.id = p_transaction_id and t.user_id = v_owner_id;

    if not found then
      raise exception 'settle_bill_occurrence: transaction % is not available', p_transaction_id
        using errcode = 'foreign_key_violation';
    end if;

    v_link_id := p_transaction_id;
    v_origin := 'linked';
  else
    select b.name, b.account_id, b.category_id
    into v_bill_name, v_bill_account_id, v_bill_category_id
    from public.bills b
    where b.id = v_bill_id and b.user_id = v_owner_id;

    if v_bill_account_id is not null then
      select a.is_archived into v_account_archived
      from public.accounts a
      where a.id = v_bill_account_id and a.user_id = v_owner_id;

      -- `is true` rather than a bare test: not-found leaves it null, and a
      -- null must fall through to "no usable account" rather than be read as
      -- either state.
      if v_account_archived is not null and not v_account_archived then
        v_generated := true;
      end if;
    end if;

    if v_generated then
      if p_generated_transaction_id is null then
        raise exception 'settle_bill_occurrence: a generated payment needs a submission key'
          using errcode = 'check_violation';
      end if;

      -- The category only if it can legally label an expense. See the header.
      if v_bill_category_id is not null then
        select c.kind, c.is_archived
        into v_category_kind, v_category_archived
        from public.categories c
        where c.id = v_bill_category_id and c.user_id = v_owner_id;

        if v_category_kind = 'expense' and v_category_archived is false then
          v_category_id := v_bill_category_id;
        end if;
      end if;

      -- An ordinary expense in every respect. `kind` is the literal 'expense',
      -- the sign is derived here (never supplied), `movement_id` is an
      -- explicit null so the row is reachable from the ordinary transaction
      -- surface, and `created_at` takes its default -- which is what the
      -- provenance rule above verifies.
      insert into public.transactions
        (id, user_id, account_id, date, merchant, kind, category_id, movement_id, amount_cents)
      values
        (p_generated_transaction_id, v_owner_id, v_bill_account_id, p_paid_on, v_bill_name,
         'expense', v_category_id, null, -v_amount_cents);

      v_link_id := p_generated_transaction_id;
      v_origin := 'generated';
    end if;
  end if;

  -- ---------- The settlement ----------
  -- `status = 'scheduled'` in the WHERE is the concurrency gate; see the
  -- header's third idempotency layer.
  update public.bill_occurrences o
  set status = 'paid',
      paid_on = p_paid_on,
      transaction_id = v_link_id,
      transaction_origin = v_origin
  where o.id = p_occurrence_id
    and o.user_id = v_owner_id
    and o.status = 'scheduled';

  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    raise exception 'settle_bill_occurrence: occurrence % was settled by another request', p_occurrence_id
      using errcode = 'check_violation';
  end if;

  return jsonb_build_object(
    'settled', true,
    'already_paid', false,
    -- The one flag the application layer branches on: it decides which routes
    -- are revalidated and whether the current month's snapshot is refreshed.
    -- A link changes no figure; a generated expense changes several.
    'ledger_changed', v_generated,
    'generated', v_generated,
    'category_applied', v_category_id is not null,
    'transaction_id', v_link_id
  );
end;
$$;

revoke execute on function public.settle_bill_occurrence(uuid, date, uuid, uuid)
  from public, anon;

grant execute on function public.settle_bill_occurrence(uuid, date, uuid, uuid)
  to authenticated;

-- ============================================================
-- public.unsettle_bill_occurrence -- unmark paid / unskip, and reverse
-- ============================================================
-- SECURITY INVOKER, same reasoning. One function for both labels, because it
-- is one transition: the target state is `scheduled` either way, and CP7's
-- reasoning for that is unchanged.
--
-- ## What is reversed, and what is never touched
--
--   * origin 'generated' -- the transaction was created by this application
--     when the occurrence was settled and has never been anything else. It is
--     deleted, in the same transaction that clears the link, so the ledger and
--     the occurrence cannot disagree. The DELETE runs under the caller's own
--     `transactions_delete_own_non_movement` policy, which is scoped to their
--     own non-movement rows -- a generated payment is ordinary and carries no
--     movement, so it is reachable; nothing else is.
--   * origin 'linked' -- the owner's own transaction. The reference is
--     cleared and the row is left exactly where it was, with its own amount,
--     category, account and date, deletable again under its ordinary rules.
--     **It is never deleted, under any circumstance.**
--   * no reference at all (a status-only paid, or a skipped occurrence) --
--     nothing but the status moves.
--
-- ## The one refusal
--
-- A generated transaction that some *other* occurrence also references is not
-- deleted; the whole call is refused with a message instead. Without this the
-- deferred `bill_occurrences_transaction_fk` would refuse it at COMMIT as a
-- bare 23503 with nothing a person could act on. Unreachable through this
-- application's own surfaces -- nothing offers a generated row in the link
-- picker -- and cheap to state.
--
-- ## Concurrency
--
-- The UPDATE carries the values that were read, so a concurrent change between
-- the read and the write matches zero rows and this reports a no-op rather
-- than deleting a transaction the occurrence no longer references.

create function public.unsettle_bill_occurrence(
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_status public.bill_occurrence_status;
  v_transaction_id uuid;
  v_origin public.bill_payment_origin;
  v_updated integer;
  v_removed boolean := false;
begin
  if v_owner_id is null then
    raise exception 'unsettle_bill_occurrence requires an authenticated caller'
      using errcode = 'invalid_authorization_specification';
  end if;

  if p_occurrence_id is null then
    raise exception 'unsettle_bill_occurrence: occurrence is required'
      using errcode = 'check_violation';
  end if;

  select o.status, o.transaction_id, o.transaction_origin
  into v_status, v_transaction_id, v_origin
  from public.bill_occurrences o
  where o.id = p_occurrence_id and o.user_id = v_owner_id;

  if v_status is null then
    raise exception 'unsettle_bill_occurrence: occurrence % is not available', p_occurrence_id
      using errcode = 'foreign_key_violation';
  end if;

  -- Already scheduled: the person's request is already satisfied.
  if v_status = 'scheduled' then
    return jsonb_build_object(
      'restored', false,
      'ledger_changed', false,
      'removed_transaction', false
    );
  end if;

  if v_origin = 'generated' then
    if exists (
      select 1
      from public.bill_occurrences o
      where o.transaction_id = v_transaction_id
        and o.user_id = v_owner_id
        and o.id <> p_occurrence_id
    ) then
      raise exception
        'unsettle_bill_occurrence: occurrence %''s payment is referenced by another occurrence', p_occurrence_id
        using errcode = 'check_violation';
    end if;
  end if;

  update public.bill_occurrences o
  set status = 'scheduled',
      paid_on = null,
      transaction_id = null,
      transaction_origin = null
  where o.id = p_occurrence_id
    and o.user_id = v_owner_id
    and o.status = v_status
    and o.transaction_id is not distinct from v_transaction_id
    and o.transaction_origin is not distinct from v_origin;

  get diagnostics v_updated = row_count;

  -- Someone else moved it between the read and the write. Reporting a no-op is
  -- the honest answer, and -- critically -- nothing is deleted on this path.
  if v_updated <> 1 then
    return jsonb_build_object(
      'restored', false,
      'ledger_changed', false,
      'removed_transaction', false
    );
  end if;

  if v_origin = 'generated' then
    delete from public.transactions t
    where t.id = v_transaction_id
      and t.user_id = v_owner_id
      and t.movement_id is null;

    get diagnostics v_updated = row_count;
    v_removed := v_updated = 1;
  end if;

  return jsonb_build_object(
    'restored', true,
    'ledger_changed', v_removed,
    'removed_transaction', v_removed
  );
end;
$$;

revoke execute on function public.unsettle_bill_occurrence(uuid) from public, anon;

grant execute on function public.unsettle_bill_occurrence(uuid) to authenticated;
