-- The Omie account to query for an order's invoice (matriz vs filial), and
-- which ICMS rate table applies, both depend on whether Mercado Livre
-- fulfilled the order (Mercado Envios Full, issued by the filial CNPJ) or
-- not (issued by the matriz CNPJ). Captured from the same /shipments/{id}
-- response already fetched for destination_state/destination_city, so it
-- shares that pair's nullable lifecycle (null until the shipment is fetched).
alter table public.orders
  add column logistic_type text;
