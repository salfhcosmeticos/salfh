create table public.product_costs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ml_item_id text not null,
  cost numeric(12,2) not null,
  updated_at timestamptz not null default now(),
  unique (user_id, ml_item_id)
);

alter table public.product_costs enable row level security;
alter table public.product_costs force row level security;

create policy product_costs_owner_all on public.product_costs
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.orders
  add column ml_commission numeric(12,2),
  add column shipping_or_fee_amount numeric(12,2),
  add column shipping_or_fee_type text check (shipping_or_fee_type in ('frete', 'taxa_fixa')),
  add column destination_state text,
  add column destination_city text,
  add column buyer_name text,
  add column sales_channel text,
  add column nf_number text,
  add column nf_fetched_at timestamptz;

alter table public.order_items
  add column ncm text;
