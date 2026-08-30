-- Object inventory: every enum, table, view, index, and function exists
-- with the correct security context.
begin;
select plan(43);

-- Enums (7)
select has_type('public', 'account_type', 'account_type enum exists');
select has_type('public', 'transaction_kind', 'transaction_kind enum exists');
select has_type('public', 'movement_kind', 'movement_kind enum exists');
select has_type('public', 'bill_frequency', 'bill_frequency enum exists');
select has_type('public', 'category_kind', 'category_kind enum exists');
select has_type('public', 'bill_occurrence_status', 'bill_occurrence_status enum exists');
-- Phase 8 CP1. Distinguishes a transaction this application generated when a
-- bill was marked paid from one the owner linked -- the fact that decides
-- whether unmarking may delete it.
select has_type('public', 'bill_payment_origin', 'bill_payment_origin enum exists');

-- Tables (11)
select has_table('public', 'profiles', 'profiles table exists');
select has_table('public', 'accounts', 'accounts table exists');
select has_table('public', 'categories', 'categories table exists');
select has_table('public', 'movements', 'movements table exists');
select has_table('public', 'transactions', 'transactions table exists');
select has_table('public', 'budgets', 'budgets table exists');
select has_table('public', 'bills', 'bills table exists');
select has_table('public', 'bill_occurrences', 'bill_occurrences table exists');
select has_table('public', 'goals', 'goals table exists');
select has_table('public', 'goal_contributions', 'goal_contributions table exists');
select has_table('public', 'net_worth_snapshots', 'net_worth_snapshots table exists');

-- Views (2)
select has_view('public', 'account_balances', 'account_balances view exists');
select has_view('public', 'goal_balances', 'goal_balances view exists');

-- security_invoker on both views (stored in reloptions, not the view text)
select ok(
  (select 'security_invoker=on' = any(c.reloptions) from pg_class c where c.oid = 'public.account_balances'::regclass),
  'account_balances is security_invoker'
);
select ok(
  (select 'security_invoker=on' = any(c.reloptions) from pg_class c where c.oid = 'public.goal_balances'::regclass),
  'goal_balances is security_invoker'
);

-- Key indexes
select has_index('public', 'transactions', 'transactions_user_id_date_created_at_id_idx', 'primary transaction ordering index exists');
select has_index('public', 'categories', 'categories_user_id_lower_name_key', 'case-insensitive category unique expression index exists');

-- Key constraints
select has_check('public', 'transactions', 'transactions has a CHECK constraint');
select has_check('public', 'net_worth_snapshots', 'net_worth_snapshots has a CHECK constraint');
select col_is_pk('public', 'net_worth_snapshots', array['user_id', 'month'], 'net_worth_snapshots PK is (user_id, month)');

-- SECURITY INVOKER functions (prosecdef = false) -- five from Phase 4,
-- two from CP2, one from CP3
select is((select prosecdef from pg_proc where oid = 'public.set_updated_at()'::regprocedure), false, 'set_updated_at is SECURITY INVOKER');
select is((select prosecdef from pg_proc where oid = 'public.validate_profile_timezone()'::regprocedure), false, 'validate_profile_timezone is SECURITY INVOKER');
select is((select prosecdef from pg_proc where oid = 'public.validate_movement()'::regprocedure), false, 'validate_movement is SECURITY INVOKER');
select is((select prosecdef from pg_proc where oid = 'public.guard_bill_occurrence_delete()'::regprocedure), false, 'guard_bill_occurrence_delete is SECURITY INVOKER');
select is(
  (select prosecdef from pg_proc where oid = 'private.next_bill_occurrence_date(date,public.bill_frequency,date)'::regprocedure),
  false,
  'next_bill_occurrence_date is SECURITY INVOKER'
);

-- Phase 7 CP2's two write guards. SECURITY INVOKER like every other
-- trigger function here: both are reachable from `authenticated`'s own
-- writes, and a definer context would hand a browser-reachable path
-- privileges it has no use for.
select is(
  (select prosecdef from pg_proc where oid = 'public.accounts_guard_update()'::regprocedure),
  false,
  'accounts_guard_update is SECURITY INVOKER'
);
select is(
  (select prosecdef from pg_proc where oid = 'public.guard_category_kind_change()'::regprocedure),
  false,
  'guard_category_kind_change is SECURITY INVOKER'
);

-- Phase 7 CP3's transaction guard, SECURITY INVOKER for the same reason:
-- under FORCE RLS the invoker sees its own profile, accounts and
-- categories, which is exactly the scope every lookup in it wants. A
-- definer context would hand a browser-reachable INSERT/UPDATE path
-- privileges it has no use for.
select is(
  (select prosecdef from pg_proc where oid = 'public.assert_transaction_refs()'::regprocedure),
  false,
  'assert_transaction_refs is SECURITY INVOKER'
);

-- Phase 8 CP1's two settlement functions. SECURITY INVOKER, like CP4's
-- movement RPCs and CP7's bill RPCs: the caller already holds every privilege
-- their bodies use (INSERT and DELETE on transactions, the four-column UPDATE
-- on bill_occurrences), and under FORCE RLS the invoker sees exactly its own
-- rows. A definer's context here would not add a check -- it would remove the
-- RLS backing every statement in them, on a path that writes the ledger.
select is(
  (select prosecdef from pg_proc where oid = 'public.settle_bill_occurrence(uuid,date,uuid,uuid)'::regprocedure),
  false,
  'settle_bill_occurrence is SECURITY INVOKER'
);
select is(
  (select prosecdef from pg_proc where oid = 'public.unsettle_bill_occurrence(uuid)'::regprocedure),
  false,
  'unsettle_bill_occurrence is SECURITY INVOKER'
);

-- Three SECURITY DEFINER system functions (prosecdef = true), owned by finance_snapshot_writer
select is(
  (select prosecdef from pg_proc where oid = 'private.generate_bill_occurrences(uuid,date)'::regprocedure),
  true,
  'generate_bill_occurrences is SECURITY DEFINER'
);
select is(
  (select pg_get_userbyid(proowner) from pg_proc where oid = 'private.generate_bill_occurrences(uuid,date)'::regprocedure),
  'finance_snapshot_writer',
  'generate_bill_occurrences is owned by finance_snapshot_writer'
);
select is(
  (select prosecdef from pg_proc where oid = 'private.write_net_worth_snapshot(uuid,text)'::regprocedure),
  true,
  'write_net_worth_snapshot is SECURITY DEFINER'
);
select is(
  (select pg_get_userbyid(proowner) from pg_proc where oid = 'private.write_net_worth_snapshot(uuid,text)'::regprocedure),
  'finance_snapshot_writer',
  'write_net_worth_snapshot is owned by finance_snapshot_writer'
);
select is(
  (select prosecdef from pg_proc where oid = 'private.write_net_worth_snapshots_for_range(uuid,text,text)'::regprocedure),
  true,
  'write_net_worth_snapshots_for_range is SECURITY DEFINER'
);
select is(
  (select pg_get_userbyid(proowner) from pg_proc where oid = 'private.write_net_worth_snapshots_for_range(uuid,text,text)'::regprocedure),
  'finance_snapshot_writer',
  'write_net_worth_snapshots_for_range is owned by finance_snapshot_writer'
);

select * from finish();
rollback;
