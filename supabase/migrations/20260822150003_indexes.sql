-- Phase 4, migration 3: indexes.
--
-- Implements docs/database-schema.md §8 exactly. No pg_trgm — the
-- trigram index on transactions.merchant is explicitly deferred to
-- Phase 6 (§8: "flagged as a Phase 6 verification item, not designed
-- here"). Indexes already supplied by a PK/UNIQUE constraint declared in
-- migration 2 (e.g. bill_occurrences UNIQUE (bill_id, due_date), the
-- net_worth_snapshots primary key) are not repeated here.

-- Primary transaction ordering/range index — matches the Phase 3
-- ordering contract (date DESC, created_at DESC, id ASC) in full. The
-- bounded from/to window (finalized in Phase 3) is a range scan on this.
create index transactions_user_id_date_created_at_id_idx
  on public.transactions (user_id, date desc, created_at desc, id asc);

-- TransactionFilters.accountId
create index transactions_user_id_account_id_date_idx
  on public.transactions (user_id, account_id, date desc);

-- spendingByCategory, budget rollups
create index transactions_user_id_category_id_date_idx
  on public.transactions (user_id, category_id, date desc);

-- Partial index — the movement invariant trigger's leg lookup.
create index transactions_movement_id_idx
  on public.transactions (movement_id)
  where movement_id is not null;

-- Case-insensitive per-user category uniqueness — a unique EXPRESSION
-- index, not an ordinary column-list UNIQUE constraint, since it indexes
-- the result of lower(name) rather than a plain column.
create unique index categories_user_id_lower_name_key
  on public.categories (user_id, lower(name));

-- Listing indexes for the remaining user-owned tables.
create index accounts_user_id_idx on public.accounts (user_id);
create index categories_user_id_idx on public.categories (user_id);
create index movements_user_id_idx on public.movements (user_id);
create index bills_user_id_idx on public.bills (user_id);
create index goals_user_id_idx on public.goals (user_id);

-- Bills page groups by due date.
create index bill_occurrences_user_id_due_date_idx
  on public.bill_occurrences (user_id, due_date);

-- Supports the derived saved_cents rollup.
create index goal_contributions_user_id_goal_id_occurred_on_idx
  on public.goal_contributions (user_id, goal_id, occurred_on desc);
