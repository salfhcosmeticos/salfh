create table public.marketplace_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  marketplace text not null check (marketplace in ('mercado_livre')),
  ml_user_id bigint not null,
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (user_id, marketplace, ml_user_id)
);

create index marketplace_accounts_user_id_idx on public.marketplace_accounts (user_id);

alter table public.marketplace_accounts enable row level security;
alter table public.marketplace_accounts force row level security;

create policy marketplace_accounts_owner_select on public.marketplace_accounts
  for select to authenticated
  using ((select auth.uid()) = user_id);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.marketplace_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ml_order_id bigint not null,
  status text not null,
  total_amount numeric(12,2) not null,
  currency_id text not null,
  order_date timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, ml_order_id)
);

create index orders_user_id_idx on public.orders (user_id);
create index orders_order_date_idx on public.orders (order_date);

alter table public.orders enable row level security;
alter table public.orders force row level security;

create policy orders_owner_select on public.orders
  for select to authenticated
  using ((select auth.uid()) = user_id);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ml_item_id text not null,
  title text not null,
  quantity integer not null,
  unit_price numeric(12,2) not null,
  created_at timestamptz not null default now(),
  unique (order_id, ml_item_id)
);

create index order_items_user_id_idx on public.order_items (user_id);
create index order_items_order_id_idx on public.order_items (order_id);

alter table public.order_items enable row level security;
alter table public.order_items force row level security;

create policy order_items_owner_select on public.order_items
  for select to authenticated
  using ((select auth.uid()) = user_id);

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.marketplace_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  run_type text not null check (run_type in ('backfill', 'reconciliation', 'webhook')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  orders_processed integer not null default 0,
  error_count integer not null default 0,
  last_error text
);

create index sync_runs_user_id_idx on public.sync_runs (user_id);

alter table public.sync_runs enable row level security;
alter table public.sync_runs force row level security;

create policy sync_runs_owner_select on public.sync_runs
  for select to authenticated
  using ((select auth.uid()) = user_id);
