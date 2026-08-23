-- Phase 4, migration 2: enums and tables.
--
-- Implements docs/database-schema.md §2 (enums) and §4 (table-by-table
-- columns) exactly. No undocumented convenience columns are added —
-- notably `categories`, `budgets`, and `goals` do NOT get a `created_at`
-- column (D6 rejected; the schema doc is authoritative and is not
-- expanded for stylistic consistency). `transactions.created_at` is kept
-- because Phase 3 added it for deterministic ordering
-- (`date DESC, created_at DESC, id ASC`).
--
-- Referential actions (corrected per D10, approved with the
-- goal_contributions correction): every relationship that blocks a
-- hard-delete while referenced uses `NO ACTION DEFERRABLE INITIALLY
-- DEFERRED`, never `RESTRICT` — `RESTRICT` is defined as "the same as
-- NO ACTION except that the check is not deferrable" (PostgreSQL docs),
-- and a non-deferrable check can fail mid-cascade during a whole-user
-- teardown, since `ON DELETE CASCADE` actions from `profiles` run as
-- separate per-child-table statements in an order this migration does
-- not control. Deferring the check to COMMIT preserves the same
-- protection (a stray hard-delete of a referenced parent still fails)
-- while letting a full user teardown succeed. The only CASCADE
-- relationships are `profiles -> auth.users`, every `user_id ->
-- profiles`, and `transactions(movement_id) -> movements` (the sole
-- supported movement-deletion path). `goal_contributions -> goals` does
-- NOT cascade — goals are soft-deleted and contribution history is
-- retained (§5, §12); teardown still succeeds because both tables
-- independently cascade via user_id -> profiles, and the cross-FK check
-- is deferred to commit, by which point neither side has rows left.
--
-- No `ON DELETE SET NULL` appears anywhere in this migration.

-- ============================================================
-- Enums (§2)
-- ============================================================

create type public.account_type as enum (
  'checking', 'savings', 'cash', 'credit', 'investment', 'loan'
);

create type public.transaction_kind as enum (
  'income', 'expense', 'refund', 'transfer', 'credit_card_payment'
);

-- Deliberately narrower than transaction_kind — makes "a movement can
-- only be one of the two paired kinds" a type-level fact.
create type public.movement_kind as enum (
  'transfer', 'credit_card_payment'
);

create type public.bill_frequency as enum (
  'weekly', 'biweekly', 'monthly', 'yearly'
);

create type public.category_kind as enum (
  'income', 'expense'
);

create type public.bill_occurrence_status as enum (
  'scheduled', 'paid', 'skipped'
);

-- ============================================================
-- profiles — 1:1 with auth.users (§4)
-- ============================================================

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Real validation is a BEFORE INSERT OR UPDATE trigger against
-- pg_catalog.pg_timezone_names (migration 4) — not a CHECK, since a
-- catalog lookup is not an immutable per-row expression.

-- ============================================================
-- accounts (§4)
-- ============================================================

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  institution text not null,
  type public.account_type not null,
  -- The only stored balance figure — current balance is the
  -- account_balances view (migration 5), never a column here.
  opening_balance_cents bigint not null,
  -- Null = not applicable to this account type.
  credit_limit_cents bigint null,
  interest_rate_bps integer null,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  constraint accounts_credit_limit_domain_ck
    check (credit_limit_cents is null or type = 'credit'),
  constraint accounts_credit_limit_nonneg_ck
    check (credit_limit_cents is null or credit_limit_cents >= 0),
  constraint accounts_interest_rate_domain_ck
    check (interest_rate_bps is null or type in ('credit', 'loan')),
  constraint accounts_interest_rate_nonneg_ck
    check (interest_rate_bps is null or interest_rate_bps >= 0)
);

-- ============================================================
-- categories — per-user, not global (§4)
-- ============================================================

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  kind public.category_kind not null,
  is_archived boolean not null default false,
  unique (id, user_id)
);
-- Case-insensitive per-user name uniqueness is a unique EXPRESSION index
-- on (user_id, lower(name)) — created in migration 3, not here, since it
-- is not an ordinary column-list UNIQUE constraint.

-- ============================================================
-- movements — parent of exactly two transaction legs (§4, §7)
-- ============================================================

create table public.movements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind public.movement_kind not null,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
-- No amounts or dates here — those belong to the two transactions legs.

-- ============================================================
-- transactions (§4, §6, §7)
-- ============================================================

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  account_id uuid not null,
  date date not null,
  merchant text not null,
  kind public.transaction_kind not null,
  -- Null on movement legs, and legally null on some ordinary rows too
  -- (an intentionally uncategorized expense is legal — see the fixture
  -- coherence test this schema is designed to keep passing).
  category_id uuid null,
  -- Non-null iff kind is a movement kind (transactions_movement_biconditional_ck).
  movement_id uuid null,
  -- Signed. Zero is legal for ordinary rows, illegal for movement legs.
  amount_cents bigint not null,
  -- Phase 3 amendment: query-ordering tie-break only, never on the
  -- Transaction DTO. Gives `date DESC, created_at DESC, id ASC` a real
  -- entry-recency tie-break for same-day rows.
  created_at timestamptz not null default now(),
  unique (id, user_id),
  constraint transactions_account_fk
    foreign key (account_id, user_id) references public.accounts (id, user_id)
    deferrable initially deferred,
  constraint transactions_category_fk
    foreign key (category_id, user_id) references public.categories (id, user_id)
    deferrable initially deferred,
  constraint transactions_movement_fk
    foreign key (movement_id, user_id) references public.movements (id, user_id)
    on delete cascade,
  -- Non-strict: a legal fixture row has amount_cents = 0 on an expense.
  -- Transfer/credit_card_payment legs are unconstrained here — see
  -- transactions_movement_nonzero_ck below.
  constraint transactions_sign_by_kind_ck check (
    (kind in ('income', 'refund') and amount_cents >= 0)
    or (kind = 'expense' and amount_cents <= 0)
    or (kind in ('transfer', 'credit_card_payment'))
  ),
  -- Combined with "exactly two legs" and "legs sum to zero" (the
  -- deferred movement trigger, migration 4), this makes opposite-signed
  -- legs a database guarantee, not just a convention.
  constraint transactions_movement_nonzero_ck check (
    kind not in ('transfer', 'credit_card_payment') or amount_cents <> 0
  ),
  -- Biconditional: delivers both "movement legs must reference a
  -- movement" and "ordinary rows must not reference one" from one check.
  constraint transactions_movement_biconditional_ck check (
    (kind in ('transfer', 'credit_card_payment')) = (movement_id is not null)
  ),
  -- One-directional only — an ordinary row is legally allowed to have
  -- no category (the reverse, movement legs never have one, follows).
  constraint transactions_movement_no_category_ck check (
    movement_id is null or category_id is null
  )
);

-- Note: FK actions declared NO ACTION (the default when omitted) plus
-- DEFERRABLE INITIALLY DEFERRED — see the migration-header comment for
-- why NO ACTION/DEFERRABLE replaces RESTRICT throughout this schema.

-- ============================================================
-- budgets (§4)
-- ============================================================

create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  category_id uuid not null,
  -- 'YYYY-MM', matches MonthKey.
  period text not null,
  limit_cents bigint not null,
  unique (user_id, category_id, period),
  constraint budgets_category_fk
    foreign key (category_id, user_id) references public.categories (id, user_id)
    deferrable initially deferred,
  constraint budgets_limit_nonneg_ck check (limit_cents >= 0),
  constraint budgets_period_format_ck check (period ~ '^\d{4}-(0[1-9]|1[0-2])$')
);

-- ============================================================
-- bills — the recurring obligation (§4, §13)
-- ============================================================

create table public.bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  -- The default/expected amount.
  amount_cents bigint not null,
  frequency public.bill_frequency not null,
  -- The original due date recurrence derives from — every rule advances
  -- from this value, never from a previously-clamped occurrence.
  anchor_date date not null,
  category_id uuid null,
  account_id uuid null,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  constraint bills_category_fk
    foreign key (category_id, user_id) references public.categories (id, user_id)
    deferrable initially deferred,
  constraint bills_account_fk
    foreign key (account_id, user_id) references public.accounts (id, user_id)
    deferrable initially deferred
);

-- ============================================================
-- bill_occurrences — one concrete due instance (§4, §13)
-- ============================================================

create table public.bill_occurrences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  bill_id uuid not null,
  due_date date not null,
  status public.bill_occurrence_status not null default 'scheduled',
  -- Copied from bills.amount_cents AT GENERATION TIME — a fixed
  -- historical fact, not a live reference to the parent. Editing a
  -- recurring bill's amount later can never retroactively change a past
  -- occurrence's effective amount, paid or otherwise.
  amount_cents bigint not null,
  -- Nullable: an occurrence may be marked paid from a manually recorded
  -- payment with no linked transaction at all.
  transaction_id uuid null,
  paid_on date null,
  created_at timestamptz not null default now(),
  -- Makes occurrence generation idempotent.
  unique (bill_id, due_date),
  constraint bill_occurrences_bill_fk
    foreign key (bill_id, user_id) references public.bills (id, user_id)
    deferrable initially deferred,
  constraint bill_occurrences_transaction_fk
    foreign key (transaction_id, user_id) references public.transactions (id, user_id)
    deferrable initially deferred,
  -- scheduled/skipped: no payment fields set. paid: paid_on required;
  -- transaction_id stays free (null or non-null) since a manually
  -- recorded payment has no linked transaction row.
  constraint bill_occurrences_status_consistency_ck check (
    (status in ('scheduled', 'skipped') and paid_on is null and transaction_id is null)
    or (status = 'paid' and paid_on is not null)
  )
);

-- ============================================================
-- goals (§4)
-- ============================================================

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  target_cents bigint not null,
  target_date date null,
  -- Soft-delete marker. All contributions are retained on archive.
  archived_at timestamptz null,
  unique (id, user_id),
  constraint goals_target_positive_ck check (target_cents > 0)
);
-- Current savedCents is not a column — it's the goal_balances rollup
-- view (migration 5).

-- ============================================================
-- goal_contributions — append-only in the application API (§4, §12)
-- ============================================================

create table public.goal_contributions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  goal_id uuid not null,
  -- Signed — negative rows are withdrawals/corrections. No <> 0
  -- constraint, consistent with the precedent for ordinary transactions.
  amount_cents bigint not null,
  occurred_on date not null,
  note text null,
  created_at timestamptz not null default now(),
  -- NO ACTION DEFERRABLE, NOT CASCADE (D10, approved with correction):
  -- goals are soft-deleted and contribution history must never be
  -- silently destroyed by a hard-delete of the parent goal. A whole-user
  -- teardown still succeeds because goal_contributions independently
  -- cascades via user_id -> profiles, and this cross-FK check is
  -- deferred to commit, by which point neither side has rows left.
  constraint goal_contributions_goal_fk
    foreign key (goal_id, user_id) references public.goals (id, user_id)
    deferrable initially deferred
);

-- ============================================================
-- net_worth_snapshots — stored, not derived (§4, §14)
-- ============================================================

create table public.net_worth_snapshots (
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- 'YYYY-MM', same format constraint as budgets.period.
  month text not null,
  assets_cents bigint not null,
  liabilities_cents bigint not null,
  net_worth_cents bigint not null,
  created_at timestamptz not null default now(),
  -- The natural key IS the primary key — no separate surrogate id or
  -- UNIQUE constraint; also what makes ON CONFLICT (user_id, month)
  -- target the primary key directly for the eventual writer.
  primary key (user_id, month),
  constraint net_worth_snapshots_month_format_ck check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  constraint net_worth_snapshots_assets_nonneg_ck check (assets_cents >= 0),
  constraint net_worth_snapshots_liabilities_nonneg_ck check (liabilities_cents >= 0),
  constraint net_worth_snapshots_identity_ck
    check (net_worth_cents = assets_cents - liabilities_cents)
);
-- Written only by the trusted snapshot mechanism (migration 8, Phase 4
-- Stage B) — never by `authenticated`, at any point in this roadmap
-- through Phase 6.
