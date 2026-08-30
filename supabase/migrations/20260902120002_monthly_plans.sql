-- Phase 8 Checkpoint 2: expected monthly income.
--
-- One new table, `public.monthly_plans`, and nothing else. No existing grant,
-- policy, trigger, constraint or function is touched, and `anon` is not named
-- in a single GRANT or policy below.
--
-- ============================================================
-- Why a table of its own rather than a row in `budgets`
-- ============================================================
--
-- The tempting shortcut is to store expected income as a `budgets` row against
-- an income category. It is wrong in four separate ways, and each on its own
-- would be enough:
--
--   1. `assert_budget_category_active_expense()` (CP6) refuses a budget whose
--      category is not an active *expense* category. Storing income there
--      means either weakening that trigger -- which exists precisely so a
--      spending limit cannot be filed against income -- or inventing a
--      sentinel category.
--   2. Every consumer of `getBudgets()` treats a row as a spending limit:
--      `budgetStatus()` compares it against `spendingByCategory()`, /budgets
--      renders a utilisation meter, and the dashboard's budget section sums
--      them. An income row would appear in all three as an expense budget that
--      is permanently 0% used.
--   3. A budget is per *category*; expected income is per *month*. Forcing a
--      category onto it invents a dimension the concept does not have, and the
--      natural key `(user_id, category_id, period)` would then permit several
--      contradictory "expected incomes" for one month.
--   4. "Total planned expense budgets" -- the figure the whole Monthly Plan
--      summary is built around -- would have to start excluding one magic row.
--      A total that needs an exception is a total that will eventually be
--      computed without it somewhere.
--
-- So: a separate relation, one row per owner per month, holding the single
-- figure a person sets. It is planning metadata in exactly the sense `budgets`
-- is -- no ledger history, nothing derived from it, and nothing else
-- referencing it.
--
-- ============================================================
-- What this table is emphatically not
-- ============================================================
--
--   * It is not income. Actual income stays derived from `transactions`
--     through `monthlyIncome()`, which is an allowlist of `kind = 'income'`
--     rows and cannot see this table. Nothing in `lib/finance/transactions.ts`
--     reads a plan.
--   * It is not a balance. No account, no net worth, and no net-worth snapshot
--     reads it: `private.write_net_worth_snapshot` sums accounts and
--     transactions and knows nothing about this relation, and no migration
--     here changes that.
--   * It is not a ledger row. There is no date, no account, no category and no
--     sign -- only a month and a non-negative magnitude.

create table public.monthly_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- 'YYYY-MM', the same MonthKey format and the same CHECK expression
  -- budgets.period and net_worth_snapshots.month already use.
  period text not null,
  -- A magnitude, never signed: "what I expect to earn this month". Zero is
  -- legal and means exactly that, which is why the CHECK is `>= 0` and not
  -- `> 0` -- the same choice budgets.limit_cents makes.
  expected_income_cents bigint not null,
  -- One plan per owner per month. This is the natural key and it is what makes
  -- "set expected income" an idempotent operation rather than a way to
  -- accumulate contradictory rows.
  unique (user_id, period),
  -- The composite key every table in this schema carries, so a future
  -- reference to a plan can be a same-owner composite FK. Nothing references
  -- it today.
  unique (id, user_id),
  constraint monthly_plans_expected_income_nonneg_ck check (expected_income_cents >= 0),
  constraint monthly_plans_period_format_ck check (period ~ '^\d{4}-(0[1-9]|1[0-2])$')
);

-- No `created_at`, matching `budgets` and `categories`: nothing orders these
-- rows by entry time and there is no same-day tie-break to preserve. The
-- read is keyed by (user_id, period) and returns at most one row.

-- The (user_id, period) UNIQUE constraint already provides the index the only
-- query pattern needs, so no additional index is created.

-- ============================================================
-- RLS: enabled and FORCED, like every other table in this schema
-- ============================================================
-- FORCE matters even though this application never runs as the table owner:
-- it is what stops a future definer function owned by a table owner from
-- silently bypassing ownership, and every other table here carries it.

alter table public.monthly_plans enable row level security;
alter table public.monthly_plans force row level security;

-- ============================================================
-- Grants -- column-scoped, exactly like budgets
-- ============================================================
-- `id` is granted on INSERT for the client-minted idempotency-key reason every
-- other create surface in this schema states: the form mints one UUID per
-- submission so a retry collides with itself on the primary key rather than
-- racing the natural key. `user_id` is INSERT-only, as on every table here: a
-- plan can never be re-homed.
--
-- `period` is INSERT-only, exactly as `budgets.period` is, and for the
-- identical reason: it decides which month the row *is*. The application only
-- ever manages the owner's current month, and getting the month wrong means
-- writing the right month's row, never rewriting this one's label.
--
-- `expected_income_cents` is the only UPDATE column, because it is the only
-- thing about an existing plan a person can meaningfully change.
--
-- The explicit REVOKE first, exactly as Phase 4's grant migration does it:
-- this schema never relies on Supabase's public-schema defaults for what a
-- new table starts out exposing.

revoke all on table public.monthly_plans from anon, authenticated;

grant select on table public.monthly_plans to authenticated;

grant insert (
  id,
  user_id,
  period,
  expected_income_cents
) on table public.monthly_plans to authenticated;

grant update (expected_income_cents) on table public.monthly_plans to authenticated;

-- Table-level, like every DELETE grant in this schema (PostgreSQL has no
-- column-level DELETE). A plan is planning metadata, not ledger history:
-- clearing one destroys nothing, and "not set" is a genuinely different state
-- from "expected zero" -- the summary renders the first as "—" and the second
-- as a real target the whole budget is measured against. Without a DELETE
-- grant there would be no way back to "not set".
grant delete on table public.monthly_plans to authenticated;

-- `anon` is granted nothing, on any operation, deliberately and permanently.

-- ============================================================
-- Operation-specific RLS policies
-- ============================================================
-- `(select auth.uid())` wrapped exactly as every other policy in this schema
-- wraps it, so Postgres evaluates it once per statement as an initPlan rather
-- than once per row scanned. One policy per operation, role-targeted, never
-- FOR ALL. UPDATE takes both USING and WITH CHECK for the reason CP2 states:
-- USING decides which existing rows may be touched, WITH CHECK decides what
-- they may look like afterwards, and a policy relying on a grant's column list
-- for its own correctness would be one column edit away from being wrong.

create policy monthly_plans_select_own on public.monthly_plans
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy monthly_plans_insert_own on public.monthly_plans
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy monthly_plans_update_own on public.monthly_plans
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy monthly_plans_delete_own on public.monthly_plans
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- No trigger. There is nothing cross-row to assert: the table references no
-- category, no account and no transaction, its format and sign rules are
-- expressible as CHECK constraints, and its month is chosen by the server from
-- the owner's own `profiles.timezone` rather than accepted from a client.
--
-- No grant for finance_snapshot_writer either. The snapshot writer sums
-- accounts and transactions; an expected figure is not a balance and must
-- never reach net worth.
