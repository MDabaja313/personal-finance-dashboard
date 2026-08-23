-- Phase 4, migration 5: views.
--
-- Exactly two views — account_balances and goal_balances — both
-- WITH (security_invoker = on). An ordinary view executes with its
-- owner's privileges by default, silently bypassing RLS on the
-- underlying tables regardless of how carefully those tables' policies
-- are written; security_invoker makes the view respect the querying
-- role's own RLS instead (docs/rls-policies.md §10).
--
-- The bill next-unpaid-occurrence projection is NOT created here — it
-- remains a Phase 6 DAL query (approved decision), not a third view.
--
-- SUM(bigint) returns numeric in PostgreSQL; both views cast the result
-- back to ::bigint so the wire type stays stable for the eventual
-- PostgREST/DB->TS boundary (empirically verified later in Phase 4, not
-- assumed here). Neither view changes any TypeScript DTO.

-- ============================================================
-- account_balances — derived current balance per account (§11)
-- ============================================================
-- opening_balance_cents + SUM(all of that account's transaction
-- amounts). LEFT JOIN so a zero-transaction account still returns its
-- opening balance and archived accounts still appear (/accounts renders
-- them in an "Archived" group). Movement legs are included in the sum —
-- they affect account balances even though they are excluded from
-- income/spending.

create view public.account_balances
with (security_invoker = on) as
select
  a.id,
  a.user_id,
  a.name,
  a.institution,
  a.type,
  a.is_archived,
  a.credit_limit_cents,
  a.interest_rate_bps,
  a.opening_balance_cents,
  (a.opening_balance_cents + coalesce(sum(t.amount_cents), 0))::bigint as balance_cents
from public.accounts a
left join public.transactions t
  on t.account_id = a.id and t.user_id = a.user_id
group by a.id;

-- ============================================================
-- goal_balances — derived saved_cents per goal (§12)
-- ============================================================
-- COALESCE(SUM(amount_cents), 0) over goal_contributions, which stay
-- signed (a withdrawal/correction is a negative row). LEFT JOIN so a
-- goal with zero contributions reports 0, not NULL. Archived goals
-- retain their contribution history and still appear here.

create view public.goal_balances
with (security_invoker = on) as
select
  g.id,
  g.user_id,
  g.name,
  g.target_cents,
  g.target_date,
  g.archived_at,
  coalesce(sum(c.amount_cents), 0)::bigint as saved_cents
from public.goals g
left join public.goal_contributions c
  on c.goal_id = g.id and c.user_id = g.user_id
group by g.id;
