-- Phase 4, migration 8: snapshot writer.
--
-- Creates the two net-worth snapshot functions, both SECURITY DEFINER,
-- owned by finance_snapshot_writer (migration 7):
--   private.write_net_worth_snapshot(p_user_id, p_month)
--   private.write_net_worth_snapshots_for_range(p_user_id, p_from_month, p_to_month)
--
-- No cron.schedule() call — Phase 4 settles and proves the privilege
-- model; scheduling is out of scope.

-- ============================================================
-- write_net_worth_snapshot — AS OF the target month's last calendar day
-- ============================================================
-- Must NOT read public.account_balances (that view is as-of-now, with
-- no month parameter — reading it for a historical month would silently
-- backfill the wrong figures the moment this runs at any time other
-- than exactly that month's boundary). Instead, for each of the user's
-- non-archived accounts:
--   opening_balance_cents + SUM(transactions.amount_cents WHERE date <= month_end)
-- Classification reproduces lib/finance/accounts.ts exactly: archived
-- accounts excluded; type IN ('credit','loan') is a liability, every
-- other type is an asset; assets_cents is the positive sum of asset
-- balances; liabilities_cents is the negated signed sum of liability
-- balances (a positive magnitude, mirroring toCents(-signedSum || 0));
-- net_worth_cents = assets_cents - liabilities_cents.
--
-- Idempotent via INSERT ... ON CONFLICT (user_id, month) DO UPDATE,
-- targeting the primary key directly.

create function private.write_net_worth_snapshot(
  p_user_id uuid,
  p_month text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month_end date;
  v_assets_cents bigint;
  v_liabilities_cents bigint;
begin
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid month key: %', p_month
      using errcode = 'invalid_parameter_value';
  end if;

  v_month_end := (to_date(p_month || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date;

  -- One pass over each of the user's non-archived accounts' as-of
  -- balances, classified exactly as lib/finance/accounts.ts:
  -- LIABILITY_TYPES = ['credit','loan'], every other type an asset.
  select
    coalesce(sum(bal.as_of_balance) filter (where bal.type not in ('credit', 'loan')), 0),
    coalesce(-sum(bal.as_of_balance) filter (where bal.type in ('credit', 'loan')), 0)
  into v_assets_cents, v_liabilities_cents
  from (
    select
      a.type,
      a.opening_balance_cents
        + coalesce(sum(t.amount_cents) filter (where t.date <= v_month_end), 0) as as_of_balance
    from public.accounts a
    left join public.transactions t
      on t.account_id = a.id and t.user_id = a.user_id and t.date <= v_month_end
    where a.user_id = p_user_id and a.is_archived = false
    group by a.id, a.type, a.opening_balance_cents
  ) bal;

  if v_assets_cents < 0 then
    raise exception 'computed a negative asset magnitude for user % month %', p_user_id, p_month
      using errcode = 'data_exception';
  end if;

  if v_liabilities_cents < 0 then
    raise exception 'computed a negative liability magnitude for user % month %', p_user_id, p_month
      using errcode = 'data_exception';
  end if;

  insert into public.net_worth_snapshots (user_id, month, assets_cents, liabilities_cents, net_worth_cents)
  values (p_user_id, p_month, v_assets_cents, v_liabilities_cents, v_assets_cents - v_liabilities_cents)
  on conflict (user_id, month) do update
    set assets_cents = excluded.assets_cents,
        liabilities_cents = excluded.liabilities_cents,
        net_worth_cents = excluded.net_worth_cents;
end;
$$;

alter function private.write_net_worth_snapshot(uuid, text) owner to finance_snapshot_writer;

revoke execute on function private.write_net_worth_snapshot(uuid, text)
  from public, anon, authenticated;

-- ============================================================
-- write_net_worth_snapshots_for_range — backfill, reusing single-month semantics
-- ============================================================
-- Calls write_net_worth_snapshot once per month in [p_from_month,
-- p_to_month] — never a divergent calculation. Safe to call repeatedly;
-- each call is itself idempotent via the single-month function's
-- ON CONFLICT.

create function private.write_net_worth_snapshots_for_range(
  p_user_id uuid,
  p_from_month text,
  p_to_month text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date;
  v_to_month date;
begin
  if p_from_month !~ '^\d{4}-(0[1-9]|1[0-2])$' or p_to_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid month key range: % .. %', p_from_month, p_to_month
      using errcode = 'invalid_parameter_value';
  end if;

  v_month := to_date(p_from_month || '-01', 'YYYY-MM-DD');
  v_to_month := to_date(p_to_month || '-01', 'YYYY-MM-DD');

  if v_month > v_to_month then
    raise exception 'invalid month key range: % is after %', p_from_month, p_to_month
      using errcode = 'invalid_parameter_value';
  end if;

  while v_month <= v_to_month loop
    perform private.write_net_worth_snapshot(p_user_id, to_char(v_month, 'YYYY-MM'));
    v_month := v_month + interval '1 month';
  end loop;
end;
$$;

alter function private.write_net_worth_snapshots_for_range(uuid, text, text) owner to finance_snapshot_writer;

revoke execute on function private.write_net_worth_snapshots_for_range(uuid, text, text)
  from public, anon, authenticated;

-- ============================================================
-- Object privileges + RLS policies for finance_snapshot_writer
-- ============================================================
-- Exactly what the two functions above need: SELECT on accounts and
-- transactions (the as-of read), SELECT+INSERT+UPDATE on
-- net_worth_snapshots (the idempotent upsert target). No DELETE. No
-- access to categories, movements, budgets, goals, goal_contributions,
-- or profiles — both functions take p_user_id explicitly and never
-- enumerate profiles.

grant select on table public.accounts to finance_snapshot_writer;
grant select on table public.transactions to finance_snapshot_writer;
grant select, insert, update on table public.net_worth_snapshots to finance_snapshot_writer;

-- Broad USING(true)/WITH CHECK(true) predicates, safe for the same
-- reason as migration 7: finance_snapshot_writer is NOLOGIN, no
-- application role is a member of it, and its only callers are the
-- SECURITY DEFINER functions above, which scope every read/write to the
-- explicit p_user_id parameter they receive.

create policy accounts_select_writer on public.accounts
  for select to finance_snapshot_writer
  using (true);

create policy transactions_select_writer on public.transactions
  for select to finance_snapshot_writer
  using (true);

create policy net_worth_snapshots_select_writer on public.net_worth_snapshots
  for select to finance_snapshot_writer
  using (true);

create policy net_worth_snapshots_insert_writer on public.net_worth_snapshots
  for insert to finance_snapshot_writer
  with check (true);

create policy net_worth_snapshots_update_writer on public.net_worth_snapshots
  for update to finance_snapshot_writer
  using (true)
  with check (true);
