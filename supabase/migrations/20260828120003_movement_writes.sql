-- Phase 7 Checkpoint 4, migration M12: movement writes.
--
-- Transfers and credit-card payments. The fourth table `authenticated`
-- may write, and the only one this checkpoint opens: budgets, bills,
-- bill_occurrences, goals, goal_contributions, net_worth_snapshots and
-- profiles keep the posture they have had since Phase 4, and
-- accounts/categories/transactions keep exactly the CP2/CP3 posture.
-- That is a checked fact, not a promise:
-- supabase/tests/database/100-write-grants.sql asserts the whole
-- privilege matrix table by table and column by column, for both
-- application roles, and proves its own table list is complete.
--
-- No earlier migration is edited, and nothing here drops or replaces an
-- existing object. In particular validate_movement() and
-- assert_transaction_refs() are used exactly as Phase 4 and CP3 left
-- them -- everything below is built to satisfy them, not to work around
-- them.
--
-- ============================================================
-- Why this checkpoint needs functions at all
-- ============================================================
--
-- Every other write in this application is one row in one statement, so
-- PostgREST -- one statement per request, each in its own transaction --
-- is a complete write path. A movement is not: it is a parent row plus
-- exactly two legs, and the database refuses every partial form of it.
--
-- Walk the three ways a caller could try to assemble one through plain
-- PostgREST, and every one of them fails *before* it can commit:
--
--   * Parent first, legs in a later request. The parent's own request
--     ends at COMMIT, where `movements_validate_movement` (Phase 4,
--     AFTER INSERT on movements, DEFERRABLE INITIALLY DEFERRED) counts
--     the legs and finds zero. The request is rolled back. There is no
--     window in which a childless movement exists.
--   * Legs first, parent later. `transactions_movement_fk` is
--     (movement_id, user_id) -> movements (id, user_id) and is **not**
--     deferrable, so a leg naming a movement that does not yet exist
--     fails immediately with 23503.
--   * Both legs in one request (PostgREST does accept an array body).
--     Same problem: the parent is in a different table, so it is still
--     a separate request, and both orders above already failed.
--
-- So a valid movement can only ever come into existence inside a single
-- transaction spanning two tables -- and the only thing `authenticated`
-- can invoke that runs several statements in one transaction is a
-- function. That is why create_movement/replace_movement exist. They
-- are not a convenience layer over statements the caller could
-- otherwise issue; they are the only reachable path, which is also what
-- makes the checks inside them a real boundary rather than an
-- application-layer suggestion.
--
-- DELETE is the exception and deliberately gets no function: removing a
-- movement *is* one statement. `delete from movements where id = ...`
-- cascades both legs through `transactions_movement_fk`'s ON DELETE
-- CASCADE, and validate_movement() skips a movement whose parent is
-- gone (that skip is precisely what distinguishes the legitimate
-- cascade from an illegitimate direct leg deletion). A function
-- wrapping one statement would add a privilege surface and no
-- guarantee.
--
-- ============================================================
-- SECURITY INVOKER, everywhere, without exception
-- ============================================================
--
-- Both functions are SECURITY INVOKER (the default; prosecdef = false),
-- like every other function in the public schema. Nothing here needs a
-- definer's privileges, and the reason is worth stating because
-- "atomic multi-table write" is exactly the shape people reach for
-- SECURITY DEFINER to implement:
--
--   * The caller already holds every privilege the bodies use -- SELECT
--     on accounts and movements, INSERT on movements (id, user_id,
--     kind), INSERT on transactions, DELETE on movements.
--   * Under FORCE RLS the invoker sees exactly its own accounts and its
--     own movements, which is the correct scope for every lookup here.
--   * The owner is taken from auth.uid() inside each body and is never
--     a parameter, so there is nothing a caller could assert about who
--     they are. A definer's context would not add a check; it would
--     only remove the RLS that currently backs every statement below.
--
-- This is also why `replace_movement` calls `public.create_movement`
-- rather than a shared helper in the `private` schema. A SECURITY
-- INVOKER function's body runs with the *caller's* privileges, and
-- `authenticated` has no USAGE on `private` (090-privileges.sql asserts
-- it) -- so a private helper would be unreachable from here, and making
-- it reachable would mean either widening that schema's exposure or
-- taking a definer's context. Composing the two public entry points
-- costs nothing and keeps both properties.
--
-- `set search_path = ''` with every object schema-qualified, as
-- elsewhere in this schema. EXECUTE is revoked from PUBLIC and anon and
-- granted only to authenticated.
--
-- `anon` is not named in a single GRANT or policy below, and its Phase 4
-- posture (zero privileges on every user-financial table and view) is
-- untouched.

-- ============================================================
-- movements -- SELECT, column-scoped INSERT, DELETE
-- ============================================================
-- Phase 4 left this table with no grant of any kind, on the recorded
-- ground that no read needed it (`Transaction.movementId` is a plain
-- column on the leg). CP4 is the feature that needs it, so this is
-- where the grant lands -- per the rule that write privileges arrive
-- with the feature that uses them, never in advance.
--
-- SELECT is needed by the edit surface: an edit has to know a
-- movement's kind before it can offer the right form, and the mutation
-- layer has to read a movement back to tell an idempotent retry from a
-- conflicting one. It is also what makes `replace_movement`'s ownership
-- check see a row at all -- a SECURITY INVOKER function has exactly the
-- caller's visibility.
--
-- INSERT is column-scoped to (id, user_id, kind), which is every column
-- on this table except `created_at`:
--
--   * `id` is grantable here for the same reason it is on transactions,
--     and for one more. Movement creation is idempotent by a
--     client-generated UUID, so a retried submission collides with
--     itself on the primary key instead of writing a second transfer.
--     And `replace_movement` re-creates the movement under its original
--     id, so an edit does not change the identity of the thing being
--     edited -- a movement id stays stable for its whole life.
--   * `user_id` is assignable because the INSERT policy's WITH CHECK
--     compares it against auth.uid(); a row is not insertable at all
--     without it. It is not updatable, because there is no UPDATE grant
--     on this table whatsoever.
--   * `created_at` takes its default, as on every other table -- a
--     column absent from a column-scoped INSERT grant simply does.
--
-- There is NO UPDATE GRANT and no UPDATE policy, and that is a design
-- decision rather than an omission. A movements row is (id, user_id,
-- kind) and nothing else: `id` is its identity, `user_id` is its owner,
-- and `kind` is what every leg's own kind must equal
-- (validate_movement() assert 3). Changing `kind` in place would
-- therefore either fail that assert or require rewriting both legs in
-- the same breath -- which is exactly what replace_movement does, by
-- delete-and-recreate. Leaving UPDATE ungranted means there is no
-- second, partial way to do it.
--
-- DELETE is table-level (PostgreSQL has no column-level DELETE) and
-- narrowed to the caller's own rows by the policy below. This is the
-- second DELETE grant in the schema, after transactions, and it is the
-- *only* correct way to remove a transfer or card payment: the legs
-- stay unreachable from the ordinary transaction surface
-- (`transactions_delete_own_non_movement` carries `movement_id IS
-- NULL`), so deleting the parent and letting the cascade take both legs
-- is not merely the preferred path, it is the only one.

grant select on table public.movements to authenticated;

grant insert (id, user_id, kind) on table public.movements to authenticated;

grant delete on table public.movements to authenticated;

-- ============================================================
-- Operation-specific RLS policies on movements
-- ============================================================
-- Three policies, one per granted operation, role-targeted, never FOR
-- ALL -- matching the shape every other policy in this schema takes.
-- `(select auth.uid())` is wrapped so Postgres evaluates it once per
-- statement as an initPlan rather than once per row scanned.
--
-- There is deliberately no UPDATE policy, because there is no UPDATE
-- grant. Both layers say the same thing, which is the posture this
-- schema takes everywhere: GRANT decides whether an operation can be
-- attempted, RLS decides which rows it may touch, and neither is
-- trusted to be the only statement of an intent.
--
-- The DELETE policy's USING is ownership and nothing more. It does not
-- need to say anything about legs: the cascade is a property of the FK,
-- and validate_movement() already refuses every arrangement in which a
-- leg could be stranded.

create policy movements_select_own on public.movements
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy movements_insert_own on public.movements
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy movements_delete_own on public.movements
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================
-- public.create_movement -- one transfer or card payment, atomically
-- ============================================================
-- The owner is derived from auth.uid() and is never a parameter. There
-- is no p_user_id here and there must never be one: a caller-supplied
-- owner is an authorization decision made by untrusted input, and no
-- amount of policy work downstream repairs that.
--
-- ## What it checks, and what it deliberately leaves to the database
--
-- Checked here, because nothing else can:
--
--   1. A positive, nonzero magnitude. The client posts "how much",
--      never a sign -- exactly as the ordinary entry form does. Zero is
--      legal for an ordinary transaction (a waived fee) and illegal for
--      a movement leg (transactions_movement_nonzero_ck), and a
--      zero-amount transfer is not a thing that happened.
--   2. Two different accounts. validate_movement() enforces it too, at
--      COMMIT; checking here means the caller gets the specific reason
--      rather than a deferred trigger's message.
--   3. Both accounts exist and belong to the caller. The lookup is
--      needed anyway, for the account names the merchant labels are
--      built from.
--   4. A credit-card payment's *destination* is a `credit` account.
--
-- Rule 4 is the one account-type rule in this schema, and it is
-- deliberately no broader than the repository already commits to.
-- `lib/types/index.ts` states the convention outright -- "source
-- (checking) leg negative, destination (card) leg positive" -- and
-- lib/finance/accounts.ts classifies `credit` as a liability whose
-- balance is stored negative, so a payment is the movement that raises
-- that balance toward zero. A card payment whose destination is not a
-- card is not a card payment. What is NOT enforced, because the
-- repository does not say it: anything about the *source*'s type.
-- Paying a card from cash, from savings, or from another card are all
-- things a person may legitimately record, and inventing a restriction
-- here would be inventing a rule the rest of the application does not
-- have.
--
-- Left to the database, on purpose, because it already owns them:
--
--   * The posted-date ceiling in the owner's own timezone, and the
--     archived-account refusal -- assert_transaction_refs() (CP3) fires
--     on these leg inserts exactly as it does on ordinary rows. CP3
--     wrote that trigger over every row specifically so CP4 would
--     inherit it rather than have to remember it.
--   * "No category on a movement leg" -- the legs below are written
--     with an explicit null, and transactions_movement_no_category_ck
--     plus assert_transaction_refs() both refuse one regardless.
--   * Exactly two legs, summing to zero, matching kinds, two distinct
--     accounts, one owner -- validate_movement(), at COMMIT, over
--     whatever this function actually left behind.
--
-- ## Idempotency
--
-- Idempotent by the caller's own movement id. The create form mints one
-- movement UUID and one UUID per leg when it mounts and keeps them
-- until the submission logically succeeds, so a double-click or a retry
-- after a lost response re-posts the same three keys and collides with
-- itself on the movements primary key (23505). This function does not
-- interpret that collision -- deciding whether it is "my own identical
-- movement" or "someone edited and resubmitted" requires comparing the
-- complete persisted payload, which lib/data/mutations/movements.ts
-- does by reading its own rows back. Blindly treating 23505 as success
-- would report a write that never happened.
--
-- ## Atomicity
--
-- A plpgsql function runs inside its caller's transaction. Every raise
-- below therefore aborts the whole request, and so does any deferred
-- constraint that fires at COMMIT afterwards. There is no arrangement
-- in which the parent lands without both legs, or one leg without the
-- other: either the entire movement commits, or none of it does.
--
-- Error text names ids and the violated rule only -- never an amount,
-- never an account name, never a balance. lib/data/db-errors.ts never
-- quotes a driver message onward, but a raise's text is also read by
-- humans in logs.
--
-- Returns the movement id, so a caller has something to read back
-- without having to trust the id it sent.

create function public.create_movement(
  p_movement_id uuid,
  p_kind public.movement_kind,
  p_date date,
  p_from_account_id uuid,
  p_to_account_id uuid,
  p_amount_cents bigint,
  p_source_leg_id uuid,
  p_destination_leg_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_from_name text;
  v_to_name text;
  v_to_type public.account_type;
  v_source_merchant text;
  v_destination_merchant text;
begin
  if v_owner_id is null then
    raise exception 'create_movement requires an authenticated caller'
      using errcode = 'invalid_authorization_specification';
  end if;

  -- ---------- 1. A positive, nonzero magnitude ----------
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'movement %: amount must be a positive number of cents', p_movement_id
      using errcode = 'check_violation';
  end if;

  -- ---------- 2. Two different accounts ----------
  if p_from_account_id is null or p_to_account_id is null then
    raise exception 'movement %: both accounts are required', p_movement_id
      using errcode = 'check_violation';
  end if;

  if p_from_account_id = p_to_account_id then
    raise exception 'movement %: the two accounts must be different', p_movement_id
      using errcode = 'check_violation';
  end if;

  -- ---------- 3. Both accounts exist and are the caller's ----------
  -- Scoped to (id, user_id) like every other lookup in this schema. A
  -- foreign account is already structurally impossible on the leg
  -- itself (transactions_account_fk is composite), so this raise is
  -- about the message, and it uses 23503 so it classifies the same way
  -- the FK's own refusal would.
  select a.name into v_from_name
  from public.accounts a
  where a.id = p_from_account_id and a.user_id = v_owner_id;

  if v_from_name is null then
    raise exception 'movement %: account % is not available', p_movement_id, p_from_account_id
      using errcode = 'foreign_key_violation';
  end if;

  select a.name, a.type into v_to_name, v_to_type
  from public.accounts a
  where a.id = p_to_account_id and a.user_id = v_owner_id;

  if v_to_name is null then
    raise exception 'movement %: account % is not available', p_movement_id, p_to_account_id
      using errcode = 'foreign_key_violation';
  end if;

  -- ---------- 4. A card payment lands on a card ----------
  if p_kind = 'credit_card_payment' and v_to_type <> 'credit' then
    raise exception
      'movement %: a credit card payment must be paid into a credit account', p_movement_id
      using errcode = 'check_violation';
  end if;

  -- ---------- Merchant labels, derived, never submitted ----------
  -- The client posts accounts and a magnitude; what a leg is *called*
  -- is a function of the movement's kind and the other account's name,
  -- so it is composed here rather than accepted as input. That keeps
  -- the pair's two labels consistent with each other by construction,
  -- and keeps a free-text field out of a row a person cannot edit
  -- directly. The shape mirrors the seed's own labels
  -- ("Transfer to Savings" / "Transfer from Checking").
  if p_kind = 'transfer' then
    v_source_merchant := 'Transfer to ' || v_to_name;
    v_destination_merchant := 'Transfer from ' || v_from_name;
  else
    v_source_merchant := 'Payment to ' || v_to_name;
    v_destination_merchant := 'Payment from ' || v_from_name;
  end if;

  -- ---------- The parent ----------
  insert into public.movements (id, user_id, kind)
  values (p_movement_id, v_owner_id, p_kind);

  -- ---------- The two legs ----------
  -- The sign is derived from the leg's role, exactly as
  -- signedAmountFor() derives an ordinary row's sign from its kind: the
  -- source is debited, the destination is credited, and the pair sums
  -- to zero by construction rather than by the caller getting it right.
  --
  -- `p_kind::text::public.transaction_kind` because movement_kind is a
  -- separate, deliberately narrower enum -- the cast through text is
  -- the supported way across two enum types that share labels, and it
  -- is what makes validate_movement()'s assert 3 (leg kind equals
  -- movement kind) true by construction here.
  --
  -- category_id is written as an explicit null rather than omitted, so
  -- "a movement leg carries no category" is visible at the statement.
  insert into public.transactions
    (id, user_id, account_id, date, merchant, kind, category_id, movement_id, amount_cents)
  values
    (p_source_leg_id, v_owner_id, p_from_account_id, p_date, v_source_merchant,
     p_kind::text::public.transaction_kind, null, p_movement_id, -p_amount_cents),
    (p_destination_leg_id, v_owner_id, p_to_account_id, p_date, v_destination_merchant,
     p_kind::text::public.transaction_kind, null, p_movement_id, p_amount_cents);

  return p_movement_id;
end;
$$;

revoke execute on function public.create_movement(
  uuid, public.movement_kind, date, uuid, uuid, bigint, uuid, uuid
) from public, anon;

grant execute on function public.create_movement(
  uuid, public.movement_kind, date, uuid, uuid, bigint, uuid, uuid
) to authenticated;

-- ============================================================
-- public.replace_movement -- edit a movement, atomically
-- ============================================================
-- Delete the parent, then re-create the whole movement under the same
-- id. That is the entire edit, and it is one transaction.
--
-- ## Why replace rather than update
--
-- An edit can change the amount, the date, the kind, and either account
-- -- and every one of those has to land on *both* legs at once or on
-- neither. `transactions_update_own_ordinary` deliberately makes a leg
-- invisible to UPDATE, so there is no statement that could rewrite one
-- half; and even with such a statement, two sequential updates would
-- pass through a state where the pair does not sum to zero. Deleting
-- the parent (which cascades both legs) and re-creating the whole
-- movement leaves exactly one shape for the database to validate at
-- COMMIT, and it is the shape the caller asked for.
--
-- ## Why nothing can survive a failed edit
--
-- The delete and everything create_movement does are one transaction.
-- If any replacement leg is refused -- an archived account, a future
-- date, a card payment aimed at a checking account, an amount of zero
-- -- the raise aborts the transaction and the DELETE is undone with
-- everything else. The original movement and both of its original legs
-- are still there, byte for byte. There is no window in which the old
-- movement is gone and the new one has not landed;
-- 140-movement-writes.sql proves it with a deliberately invalid
-- replacement and then re-reads the original pair.
--
-- ## The ownership check
--
-- Explicit, on top of RLS, and it runs before the delete. RLS already
-- makes another owner's movement invisible, so `movements_delete_own`
-- would simply match zero rows -- and a DELETE that matches nothing
-- raises nothing, which is the failure mode that looks like success.
-- Checking first turns that silence into a refusal. `check_violation`
-- rather than a bespoke code because the mutation layer preflights this
-- case and produces the message a person reads; this is the backstop
-- for the race between that preflight and this statement.
--
-- Leg ids are supplied by the caller and reused deliberately: the
-- mutation layer passes the movement's existing leg ids, so an edit
-- keeps a leg's identity rather than minting a new row id for a row
-- that already existed. The DELETE above removes them inside this same
-- transaction, so re-inserting the same ids cannot collide with itself.

create function public.replace_movement(
  p_movement_id uuid,
  p_kind public.movement_kind,
  p_date date,
  p_from_account_id uuid,
  p_to_account_id uuid,
  p_amount_cents bigint,
  p_source_leg_id uuid,
  p_destination_leg_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner_id uuid := (select auth.uid());
  v_exists boolean;
begin
  if v_owner_id is null then
    raise exception 'replace_movement requires an authenticated caller'
      using errcode = 'invalid_authorization_specification';
  end if;

  select true into v_exists
  from public.movements m
  where m.id = p_movement_id and m.user_id = v_owner_id;

  if v_exists is not true then
    raise exception 'movement %: not available to this caller', p_movement_id
      using errcode = 'check_violation';
  end if;

  -- Cascades both legs (transactions_movement_fk ON DELETE CASCADE).
  -- validate_movement() skips a movement whose parent no longer exists,
  -- which is what lets this intermediate state be legal at all -- and
  -- by COMMIT the parent is back, with exactly two legs.
  delete from public.movements
  where id = p_movement_id and user_id = v_owner_id;

  -- Composed rather than duplicated: see the SECURITY INVOKER note in
  -- this file's header for why this is a public entry point rather than
  -- a shared helper in `private`.
  return public.create_movement(
    p_movement_id, p_kind, p_date,
    p_from_account_id, p_to_account_id, p_amount_cents,
    p_source_leg_id, p_destination_leg_id
  );
end;
$$;

revoke execute on function public.replace_movement(
  uuid, public.movement_kind, date, uuid, uuid, bigint, uuid, uuid
) from public, anon;

grant execute on function public.replace_movement(
  uuid, public.movement_kind, date, uuid, uuid, bigint, uuid, uuid
) to authenticated;
