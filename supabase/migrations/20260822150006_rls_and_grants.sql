-- Phase 4, migration 6: RLS and grants.
--
-- ENABLE + FORCE RLS on all 11 tables. authenticated receives SELECT on
-- exactly 10 of them — movements is deliberately excluded, since it is
-- an internal integrity parent with no Phase 6 read path (Transaction
-- DTO carries movementId as a plain column; nothing joins to movements).
-- Phase 7 adds the grant/policy alongside movement mutation behavior if
-- and when that becomes a read requirement.
--
-- GRANT and RLS are two separate layers, both required: GRANT decides
-- whether an operation can be attempted at all; RLS then decides which
-- rows a permitted operation can touch. Every REVOKE here is explicit —
-- Supabase's public-schema defaults are not relied upon.
--
-- Every policy is operation-specific (FOR SELECT only) and role-
-- targeted (TO authenticated). No FOR ALL policy exists anywhere in
-- this schema. No INSERT/UPDATE/DELETE grant or policy is created —
-- that is entirely Phase 7 scope, added per mutation as it is built.

-- ============================================================
-- ENABLE + FORCE RLS — all 11 tables, uniformly
-- ============================================================
-- FORCE matters specifically because without it, RLS policies do not
-- apply to a table's owner (the role that ran this migration), which
-- would otherwise leave that role an unfiltered path to every row.

alter table public.profiles enable row level security;
alter table public.profiles force row level security;

alter table public.accounts enable row level security;
alter table public.accounts force row level security;

alter table public.categories enable row level security;
alter table public.categories force row level security;

alter table public.movements enable row level security;
alter table public.movements force row level security;

alter table public.transactions enable row level security;
alter table public.transactions force row level security;

alter table public.budgets enable row level security;
alter table public.budgets force row level security;

alter table public.bills enable row level security;
alter table public.bills force row level security;

alter table public.bill_occurrences enable row level security;
alter table public.bill_occurrences force row level security;

alter table public.goals enable row level security;
alter table public.goals force row level security;

alter table public.goal_contributions enable row level security;
alter table public.goal_contributions force row level security;

alter table public.net_worth_snapshots enable row level security;
alter table public.net_worth_snapshots force row level security;

-- ============================================================
-- REVOKE ALL — every table and view, from anon and authenticated
-- ============================================================
-- Explicit, not relying on Supabase's public-schema defaults (which, on
-- this CLI version, already default to NOT auto-exposing new entities —
-- see the auto_expose_new_tables comment in supabase/config.toml — but
-- this migration does not depend on that default holding).

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.accounts from anon, authenticated;
revoke all on table public.categories from anon, authenticated;
revoke all on table public.movements from anon, authenticated;
revoke all on table public.transactions from anon, authenticated;
revoke all on table public.budgets from anon, authenticated;
revoke all on table public.bills from anon, authenticated;
revoke all on table public.bill_occurrences from anon, authenticated;
revoke all on table public.goals from anon, authenticated;
revoke all on table public.goal_contributions from anon, authenticated;
revoke all on table public.net_worth_snapshots from anon, authenticated;

revoke all on table public.account_balances from anon, authenticated;
revoke all on table public.goal_balances from anon, authenticated;

-- ============================================================
-- GRANT SELECT — authenticated, exactly 10 tables (movements excluded)
-- ============================================================

grant select on table public.profiles to authenticated;
grant select on table public.accounts to authenticated;
grant select on table public.categories to authenticated;
-- movements: no grant. RLS is ENABLE+FORCE with no policy below, so any
-- permitted-but-unmatched access would return zero rows rather than
-- error — but there is no grant, so authenticated cannot even attempt
-- SELECT; it fails at the privilege layer (42501) before RLS is
-- consulted at all.
grant select on table public.transactions to authenticated;
grant select on table public.budgets to authenticated;
grant select on table public.bills to authenticated;
grant select on table public.bill_occurrences to authenticated;
grant select on table public.goals to authenticated;
grant select on table public.goal_contributions to authenticated;
grant select on table public.net_worth_snapshots to authenticated;

-- Base-table grants required for the security_invoker views to work
-- under the querying role's own privileges (already granted above:
-- accounts, transactions for account_balances; goals,
-- goal_contributions for goal_balances). movements is not needed by
-- either view.

grant select on table public.account_balances to authenticated;
grant select on table public.goal_balances to authenticated;

-- ============================================================
-- SELECT ownership policies — exactly 10, operation-specific
-- ============================================================
-- (select auth.uid()) is wrapped so Postgres evaluates it once per
-- statement (an initPlan) rather than once per row scanned.

create policy profiles_select_own on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

create policy accounts_select_own on public.accounts
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy categories_select_own on public.categories
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- No policy on movements — deliberate (see above).

create policy transactions_select_own on public.transactions
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy budgets_select_own on public.budgets
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy bills_select_own on public.bills
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy bill_occurrences_select_own on public.bill_occurrences
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy goals_select_own on public.goals
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy goal_contributions_select_own on public.goal_contributions
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy net_worth_snapshots_select_own on public.net_worth_snapshots
  for select to authenticated
  using ((select auth.uid()) = user_id);
