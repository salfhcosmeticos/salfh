-- The seller's own SKU (e.g. "SF9004") comes from Mercado Livre's own order
-- data (order_items[].item.seller_custom_field, shown to the seller as
-- "SKU" on their own order page) and is available immediately at sync time -
-- no need to wait for the NF-e invoice. The same code is also what the
-- seller's ERP (OMIE) prints as "CÓDIGO PRODUTO" on the invoice, so it is
-- the reliable join key for matching NCM per item, replacing the earlier
-- (and incorrect) attempt to match on Mercado Livre's own listing id.
alter table public.order_items
  add column product_code text;

-- product_costs was keyed on ml_item_id (the Mercado Livre listing id) by
-- mistake - the owner registers cost per SKU, which is product_code.
alter table public.product_costs
  rename column ml_item_id to product_code;
