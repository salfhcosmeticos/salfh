alter table public.orders
  add column nfe_xml_url text,
  add column nfe_danfe_url text;

-- Bridges an NFe.NotaAutorizada webhook event to its Mercado Livre order
-- when the order hasn't been synced from Mercado Livre yet at the moment
-- the invoice is authorized. Cleared out by applyPendingOmieInvoices once
-- the matching orders row shows up - this table is scratch space, not a
-- durable record, so it carries no RLS select policy: only the service-role
-- client (server-side sync code) ever touches it, and RLS with zero
-- policies (but enabled) locks out every other role by default.
create table public.pending_omie_invoices (
  id uuid primary key default gen_random_uuid(),
  ml_order_id bigint not null unique,
  nf_number text not null,
  nfe_xml_url text,
  nfe_danfe_url text,
  ncm_by_product_code jsonb not null,
  received_at timestamptz not null default now()
);

alter table public.pending_omie_invoices enable row level security;
alter table public.pending_omie_invoices force row level security;
