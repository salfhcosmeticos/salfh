# Margem de contribuição (Mercado Livre) — design

**Date:** 2026-08-05
**Status:** approved by owner, ready for spec review
**Builds on:** `2026-08-03-vendas-mercadolivre-design.md` (Vendas module) and `2026-08-04-dashboard-shell-live-revenue-design.md` (sidebar shell, KPI card pattern)

## Purpose

The owner wants to see, per Mercado Livre order, how much money is actually left after the marketplace's own charges and the state sales tax (ICMS) — not just gross revenue. This is "Margem de contribuição": `Lucro líquido ÷ Custo do produto`, where lucro líquido already subtracts Mercado Livre's commission, the shipping cost (or fixed fee) it charges, and the ICMS the owner owes on the sale. The owner's company is taxed under the "Lucro Real" regime, which means it also generates recoverable tax credits (PIS, COFINS, ICMS) on some of those same charges — but the owner wants those credits shown for reference only in this first version, not yet folded into the formula, until their accounting team specifies exactly how each credit applies.

The sidebar already has a disabled "Margem de contribuição (em breve)" entry (added in the dashboard-shell spec). This feature turns it into a real page.

## Non-goals

- **Other marketplaces.** The owner also sells on Shopee (3 accounts), TikTok Shop, Amazon, and their own website, but only Mercado Livre is integrated into this dashboard today. This spec is Mercado Livre only. A future phase adds a "por conta" breakdown once other marketplaces are connected — not needed now since there's exactly one Mercado Livre account.
- **Tax credits in the formula.** PIS (1.65%), COFINS (7.60%), and ICMS (12%) credits on commission/shipping/fixed-fee are computed and displayed as reference columns, but are explicitly **not** subtracted in `lucro líquido` yet. The owner will specify with their accountant how each credit factors in; that's a follow-up change to the calculation functions described below, not a data or architecture change.
- **Mercado Ads spend.** Deferred entirely (not even as a lump sum) until the Mercado Ads API is integrated, which the owner expects will let ad spend be attributed per order (Mercado Livre already tags which item in an order was "Venda por publicidade").
- **OMIE ERP integration.** The owner will integrate their OMIE ERP later for automated product cost data. For now, product cost is entered manually per SKU. Swapping the cost source to OMIE later changes only where `product_costs.cost` comes from, not the margin calculation or the page.
- **Per-item cost splitting within a multi-item order.** Mercado Livre returns one commission and one shipping/fee charge for the whole order, not per item — confirmed against a real multi-item order screenshot the owner provided. This spec keeps that granularity: one row per order, with product cost summed across the order's items when there's more than one.
- **NCM data entry.** NCM comes from the fiscal invoice XML (every Brazilian nota fiscal has it), not from manual product registration.

## Architecture

### Data model

Three schema changes, in a new migration:

**New table `product_costs`** — the owner's manual cost registry, one row per SKU:

```sql
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
```

This is the one table in the project so far that needs owner **write** access from the dashboard itself (every other table is written only by the sync/webhook backend using the service-role client) — the owner types costs in directly. The policy is `for all` instead of the `for select`-only pattern used elsewhere, scoped the same way by `user_id`.

**New columns on `orders`** (nullable — populated by the sync extension below, absent until then):

- `ml_commission numeric(12,2)`
- `shipping_or_fee_amount numeric(12,2)`
- `shipping_or_fee_type text check (shipping_or_fee_type in ('frete', 'taxa_fixa'))`
- `destination_state text` (UF, e.g. `'PR'`, `'SP'`)
- `destination_city text`
- `buyer_name text`
- `sales_channel text`
- `nf_number text`
- `nf_fetched_at timestamptz` — null until a fiscal document has been successfully retrieved for this order; the retry job (below) uses this to find orders still waiting.

**New column on `order_items`:**

- `ncm text` — nullable until the fiscal document is fetched.

### Fetching the data

The existing sync pipeline (`src/lib/mercadolivre/sync.ts`, run both by the backfill and by the webhook handler) is extended so that, for every order it upserts, it also fetches and stores:

1. **Commission, shipping/fee amount, destination city/state.** Confirmed available from Mercado Livre's existing order and shipment data (the order's fee breakdown, and the shipment's `receiver_address`, which includes `city`/`state` as structured `{id, name}` objects) — likely obtainable from data already being fetched or one additional call per order to the shipment endpoint. Exact field names are confirmed against a real order/shipment response during implementation, not guessed here.
2. **Buyer name.** Via the order's billing-info endpoint (`GET /orders/{id}/billing_info`), the same data Mercado Livre uses to issue an invoice — this is deliberately a narrower, invoicing-purpose endpoint rather than the general buyer profile, consistent with LGPD-driven access limits on marketplace buyer PII.
3. **Sales channel.** From tags/metadata already present on the order (e.g., the fulfillment/logistics type, ads-attribution tag).
4. **NF number and NCM (per item).** Via the Fiscal Documents API (`GET /v2/fiscalDocuments?orderId=...`, then `GET /v2/fiscalDocuments/download/{document_item_id}` for the XML), which explicitly supports invoices uploaded by a third-party ERP — OMIE, in the owner's case, which already issues and attaches the NF-e for every Mercado Livre sale.

**The invoice may not exist yet when the order first syncs** — NF-e issuance can lag the sale by hours or days. `nf_fetched_at` stays null and `order_items.ncm`/`orders.nf_number` stay null until a fiscal document shows up. A periodic retry (piggybacking on the existing `reconciliation` sync run type already in `sync_runs`) re-checks orders where `nf_fetched_at is null` and are still within a reasonable age window, rather than treating a missing invoice as an error.

**Whether this dashboard's existing Mercado Livre app registration already has access to the Fiscal Documents API, or needs an additional product/scope grant from ML's DevCenter, is unconfirmed** — Mercado Livre's fiscal APIs commonly require a separate access grant. This is flagged here so the implementation plan budgets time to check and, if needed, request it before the sync extension can work end-to-end.

### Calculation

New pure module, `src/lib/margin/calculateMargin.ts` (mirrors the existing `src/lib/sales/aggregate.ts` pattern: pure functions, no I/O, easy to unit test), computing derived values from the raw stored facts rather than storing the computed result — so a future formula change (adding the tax credits, adjusting a rate) only touches this module, never triggers a data backfill:

```ts
export type IcmsExemptNcm = '33059000' | '33051000'

export function icmsDebitRate(destinationState: string, ncm: string | null): number {
  const isExemptCosmetic = destinationState === 'PR' && (ncm === '33059000' || ncm === '33051000')
  if (isExemptCosmetic) return 0
  if (destinationState === 'PR') return 0.195
  if (['MG', 'SP', 'RJ', 'SC', 'RS'].includes(destinationState)) return 0.12
  return 0.07
}

export interface OrderMarginInput {
  saleAmount: number
  productCost: number | null // null = not registered yet
  commission: number
  shippingOrFeeAmount: number
  items: { itemValue: number; ncm: string | null }[] // for per-item ICMS, summed
  destinationState: string | null // null = not yet known (no shipment data)
  nfPending: boolean // true = invoice not fetched yet, NCM unavailable
}

export interface OrderMarginResult {
  icmsDebit: number | null // null when destinationState or any item's ncm is unknown
  netProfit: number | null
  marginPct: number | null // null when productCost is null (not registered) or netProfit is null
  creditPis: number
  creditCofins: number
  creditIcmsOnShipping: number // 0 when shippingOrFeeType is 'taxa_fixa', not 'frete'
}

export function calculateOrderMargin(input: OrderMarginInput): OrderMarginResult
```

`icmsDebit` sums `itemValue * icmsDebitRate(destinationState, item.ncm)` across the order's items — so a multi-item order with mixed NCMs still gets a correct total even though the page shows one row. The three "reference only" credit fields are always computable from `commission`/`shippingOrFeeAmount` alone (no NCM/state dependency): `creditPis = (commission + shippingOrFeeAmount) * 0.0165`, `creditCofins = (commission + shippingOrFeeAmount) * 0.076`, `creditIcmsOnShipping = shippingOrFeeType === 'frete' ? shippingOrFeeAmount * 0.12 : 0`.

Period summaries (Acumulado / Mês atual / Mês anterior) are `sum(netProfit) / sum(productCost)` across the orders in that period — the same shape as `summarizeRevenue`'s `PeriodComparison`, reusing that existing type/pattern where it fits, extended with a `marginPct: number | null` per period (null when the period's summed `productCost` is zero, mirroring the existing "no previous-period revenue" null-handling already established for `changePct`).

### Page

`/margem-contribuicao` (the sidebar's existing "Margem de contribuição" entry becomes a real link, same pattern as "Vendas" — the other six placeholders stay disabled). Layout mirrors the Vendas page:

- Three summary cards at the top (Acumulado, Mês atual, Mês anterior), same `Card`/`Badge` components as the Vendas KPI cards.
- A table below, one row per order: Data, Nº do pedido, Nº da NF, Cliente, Cidade/UF, Canal de venda, Produto(s), Custo do produto, Comissão, Frete/Taxa, Débito ICMS, Lucro líquido, Margem %, and the three reference-only credit columns.
- A small "Cadastrar custo" entry point opening a simple list/form for `product_costs` (SKU + cost, add/edit) — a CRUD screen scoped to exactly this table, not a general "Produtos" module.

## Error handling

- **Product cost not registered:** the row still shows sale amount, commission, shipping/fee, and ICMS debit; the margin cell shows "custo não cadastrado" instead of a number.
- **Invoice not fetched yet:** NCM, NF number, and ICMS debit show "aguardando XML"; everything else in the row renders normally. The retry job picks these up automatically — this is expected, ordinary state, not an error.
- **Buyer name or city missing:** renders blank. Never blocks the row.
- **Mercado Livre API failure during sync (commission/shipment/billing/fiscal fetch):** matches the project's existing philosophy (`backfillOrders` already degrades gracefully on failure) — the order still syncs with whatever core fields it already has (from the existing sync path), the new fields stay null, and the page shows the same "aguardando XML" / blank states as above. Never crashes the sync run or the page.

## Testing

- `calculateOrderMargin`/`icmsDebitRate`: unit tests covering PR+exempt-NCM (0%), PR+non-exempt NCM (19.5%), each of the five 12% states, a non-listed state (7%), a multi-item order with mixed NCMs (sums correctly), `productCost: null` (margin is null, not a crash or a 0), `nfPending: true` (ICMS debit null), and the three credit calculations against known inputs.
- Period summary aggregation: empty-orders case (all nulls/zeros, no divide-by-zero), a zero-product-cost period (`marginPct: null`).
- Sync extension: unit tests with mocked Mercado Livre responses for the new fields, plus a case where the fiscal document call returns "not found yet" and confirms `nf_fetched_at` stays null without failing the sync run.
- `product_costs` CRUD: covered by existing RLS-policy testing conventions (verify a user can only read/write their own rows).

## Rollout

New migration (product_costs table + RLS policy, new columns on `orders`/`order_items`). Before the sync extension can fetch fiscal documents, confirm whether the Mercado Livre app registration needs an additional DevCenter product/scope grant for the Fiscal Documents API — this is the one open technical risk flagged above, and should be checked early in implementation since it can block the whole NF/NCM path if a manual approval process is involved. Ships the same way as prior work: commits to `main`, deployed via the existing EasyPanel pipeline. No changes to the read-only marketplace-API constraint — every new Mercado Livre call added here is a GET.
