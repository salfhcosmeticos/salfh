# Margem de contribuição (Mercado Livre) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the sidebar's disabled "Margem de contribuição" entry into a real page showing, per Mercado Livre order, net profit after commission/shipping/ICMS and a margin percentage against the manually-registered product cost.

**Architecture:** Extend the existing Mercado Livre sync pipeline to also fetch and store commission, shipping/fixed-fee, destination address, buyer name, sales channel, and (via the Fiscal Documents API, since the owner's OMIE ERP attaches an NF-e XML to every order) the invoice number and each item's NCM. A new pure calculation module derives ICMS debit, net profit, and margin from those stored facts at render time — not stored pre-computed — so a future formula change (folding in the PIS/COFINS/ICMS credits, once the owner's accountant specifies how) only touches that module. A new manual "product cost" registry lets the owner record what each SKU cost them, since neither Mercado Livre nor the invoice knows that.

**Tech Stack:** Same as the rest of the project — Next.js 15 App Router, Supabase (Postgres + RLS), Vitest, date-fns, shadcn/ui. Adds `fast-xml-parser` (new dependency) to parse the NF-e XML.

**Builds on:** `docs/superpowers/specs/2026-08-05-margem-contribuicao-design.md`.

## Global Constraints

- Mercado Livre only — no other marketplace, no "por conta" breakdown (there's exactly one ML account today).
- PIS/COFINS/ICMS credits are computed and displayed as reference-only columns; they are never subtracted in `netProfit`/`marginPct`. Do not fold them into the formula — the owner will specify how once their accountant confirms it.
- Mercado Ads spend is out of scope entirely (not even as an aggregate) until the Mercado Ads API is integrated.
- No OMIE integration — product cost is manual entry only (`product_costs` table).
- One row per order, not per item. When an order has multiple items, product cost is the sum across the order's items; commission and shipping/fee are already order-level values from Mercado Livre.
- Every new Mercado Livre API call is a GET — this project's marketplace APIs stay read-only.
- TypeScript strict mode; `@/*` path alias maps to `src/*`; `@testing-library/jest-dom` is not installed — component tests use plain Vitest assertions only.
- All UI copy is Portuguese (pt-BR): "custo não cadastrado", "aguardando XML" are the exact required strings for those two pending states.
- Currency via the existing `formatCurrencyBRL` helper; percentages formatted the same way the existing KPI cards do (`Math.abs(pct).toFixed(1) + '%'`).

## Known Verification Risk (read before Task 4)

Two things this plan cannot fully confirm without a live, authenticated Mercado Livre seller account (not available in this environment):

1. **Whether this project's Mercado Livre app registration already has access to the Fiscal Documents API**, or needs an additional product/scope grant requested from ML's DevCenter. If Task 4/5's fiscal document calls return a 403/permission error rather than a 404/empty-result, this is why — escalate to the human rather than trying to work around it in code.
2. **The exact field names for per-order commission and seller-paid shipping.** Documentation and community sources point to `order_items[].sale_fee` (with a `sale_fee_details` breakdown that includes a `fixed_fee` component — plausibly what the owner calls "taxa fixa") for commission, and `GET /shipments/{id}/costs`'s `senders` list for seller-paid shipping — but neither is confirmed against a real Brazilian order response. Task 4's first step is to fetch one real order (and its shipment, if any) for the connected account and record the actual JSON shape before finalizing the extraction code — this is not optional groundwork, it's the task's first deliverable.

---

### Task 1: Migration — product_costs table and new order/item columns

**Files:**
- Create: `supabase/migrations/0003_margem_contribuicao.sql`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `public.product_costs(user_id, ml_item_id, cost)` (owner-writable, RLS-scoped); `orders.ml_commission`, `orders.shipping_or_fee_amount`, `orders.shipping_or_fee_type`, `orders.destination_state`, `orders.destination_city`, `orders.buyer_name`, `orders.sales_channel`, `orders.nf_number`, `orders.nf_fetched_at`; `order_items.ncm` — all consumed by Task 3 (product_costs) and Task 5 (sync).

- [ ] **Step 1: Write the migration**

`supabase/migrations/0003_margem_contribuicao.sql`:

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
```

- [ ] **Step 2: Apply the migration**

Use the Supabase MCP tools if available in your environment (`mcp__plugin_supabase_supabase__apply_migration` with project_id `lrscmdpaprfsprgceymz`, a snake_case name, and this file's SQL as `query`); otherwise apply it via the Supabase Dashboard's SQL Editor (Dashboard → SQL Editor → paste → Run).

- [ ] **Step 3: Verify**

Run (via `execute_sql` or the SQL Editor):

```sql
select table_name, column_name from information_schema.columns
where table_schema = 'public'
  and (table_name in ('orders', 'order_items') and column_name in
    ('ml_commission','shipping_or_fee_amount','shipping_or_fee_type','destination_state',
     'destination_city','buyer_name','sales_channel','nf_number','nf_fetched_at','ncm'))
order by table_name, column_name;
```

Expected: all 10 columns listed. Also run:

```sql
select rowsecurity from pg_tables where tablename = 'product_costs';
```

Expected: `true`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0003_margem_contribuicao.sql
git commit -m "feat: add product_costs table and margin-related order/item columns"
```

---

### Task 2: Margin calculation module

**Files:**
- Create: `src/lib/margin/calculateMargin.ts`
- Test: `src/lib/margin/calculateMargin.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions, no I/O).
- Produces: `icmsDebitRate(destinationState: string, ncm: string | null): number`; `OrderMarginInput`, `OrderMarginResult`, `calculateOrderMargin(input: OrderMarginInput): OrderMarginResult`; `MarginPeriodSummary`, `summarizeMarginPeriod(orders: { netProfit: number | null; productCost: number | null }[]): MarginPeriodSummary` — consumed by Task 7 (page).

- [ ] **Step 1: Write the failing tests**

`src/lib/margin/calculateMargin.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { icmsDebitRate, calculateOrderMargin, summarizeMarginPeriod } from './calculateMargin'

describe('icmsDebitRate', () => {
  it('is 0% for a Parana destination with an exempt cosmetic NCM', () => {
    expect(icmsDebitRate('PR', '33059000')).toBe(0)
    expect(icmsDebitRate('PR', '33051000')).toBe(0)
  })

  it('is 19.5% for a Parana destination with a non-exempt NCM', () => {
    expect(icmsDebitRate('PR', '12345678')).toBe(0.195)
  })

  it('is 19.5% for a Parana destination with no NCM known yet', () => {
    expect(icmsDebitRate('PR', null)).toBe(0.195)
  })

  it('is 12% for MG, SP, RJ, SC and RS regardless of NCM', () => {
    for (const state of ['MG', 'SP', 'RJ', 'SC', 'RS']) {
      expect(icmsDebitRate(state, '33059000')).toBe(0.12)
      expect(icmsDebitRate(state, null)).toBe(0.12)
    }
  })

  it('is 7% for any other state', () => {
    expect(icmsDebitRate('BA', null)).toBe(0.07)
    expect(icmsDebitRate('AM', '33059000')).toBe(0.07)
  })
})

describe('calculateOrderMargin', () => {
  const baseInput = {
    saleAmount: 236.9,
    productCost: 100,
    commission: 41.66,
    shippingOrFeeAmount: 29,
    shippingOrFeeType: 'frete' as const,
    items: [
      { itemValue: 169.9, ncm: '33059000' },
      { itemValue: 67, ncm: '33059000' },
    ],
    destinationState: 'SP',
    nfPending: false,
  }

  it('computes ICMS debit as the sum across items using each item value and NCM', () => {
    const result = calculateOrderMargin(baseInput)
    expect(result.icmsDebit).toBeCloseTo(28.428, 3) // (169.9 + 67) * 0.12
  })

  it('computes net profit as sale amount minus ICMS debit, shipping/fee and commission', () => {
    const result = calculateOrderMargin(baseInput)
    expect(result.netProfit).toBeCloseTo(137.812, 3) // 236.9 - 28.428 - 29 - 41.66
  })

  it('computes margin % as net profit divided by product cost, times 100', () => {
    const result = calculateOrderMargin(baseInput)
    expect(result.marginPct).toBeCloseTo(137.812, 3) // 137.812 / 100 * 100
  })

  it('returns marginPct: null when product cost is not registered, without affecting netProfit', () => {
    const result = calculateOrderMargin({ ...baseInput, productCost: null })
    expect(result.marginPct).toBeNull()
    expect(result.netProfit).not.toBeNull()
  })

  it('returns icmsDebit, netProfit and marginPct: null when the invoice has not been fetched yet', () => {
    const result = calculateOrderMargin({ ...baseInput, nfPending: true })
    expect(result.icmsDebit).toBeNull()
    expect(result.netProfit).toBeNull()
    expect(result.marginPct).toBeNull()
  })

  it('returns icmsDebit: null when the destination state is not yet known', () => {
    const result = calculateOrderMargin({ ...baseInput, destinationState: null })
    expect(result.icmsDebit).toBeNull()
  })

  it('applies the 0% exempt rate to a Parana order for the cosmetic NCM', () => {
    const result = calculateOrderMargin({ ...baseInput, destinationState: 'PR' })
    expect(result.icmsDebit).toBe(0)
  })

  it('computes PIS, COFINS and ICMS-on-shipping credits from commission and shipping even when the NF is pending', () => {
    const result = calculateOrderMargin({ ...baseInput, nfPending: true })
    expect(result.creditPis).toBeCloseTo((41.66 + 29) * 0.0165, 6)
    expect(result.creditCofins).toBeCloseTo((41.66 + 29) * 0.076, 6)
    expect(result.creditIcmsOnShipping).toBeCloseTo(29 * 0.12, 6)
  })

  it('returns zero ICMS-on-shipping credit when the charge was a fixed fee, not freight', () => {
    const result = calculateOrderMargin({ ...baseInput, shippingOrFeeType: 'taxa_fixa' })
    expect(result.creditIcmsOnShipping).toBe(0)
  })
})

describe('summarizeMarginPeriod', () => {
  it('sums net profit and product cost across orders, then derives a weighted margin', () => {
    const summary = summarizeMarginPeriod([
      { netProfit: 100, productCost: 50 },
      { netProfit: 200, productCost: 150 },
    ])
    expect(summary).toEqual({ netProfit: 300, productCost: 200, marginPct: 150 }) // 300/200*100
  })

  it('excludes orders with an unregistered cost or a pending invoice from the sums', () => {
    const summary = summarizeMarginPeriod([
      { netProfit: 100, productCost: 50 },
      { netProfit: null, productCost: null },
    ])
    expect(summary.netProfit).toBe(100)
    expect(summary.productCost).toBe(50)
  })

  it('returns marginPct: null and zero sums for an empty list', () => {
    expect(summarizeMarginPeriod([])).toEqual({ netProfit: 0, productCost: 0, marginPct: null })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- calculateMargin
```

Expected: FAIL — `Cannot find module './calculateMargin'`.

- [ ] **Step 3: Implement the module**

`src/lib/margin/calculateMargin.ts`:

```ts
const ICMS_TWELVE_PERCENT_STATES = ['MG', 'SP', 'RJ', 'SC', 'RS']
const ICMS_EXEMPT_COSMETIC_NCMS = ['33059000', '33051000']
const PIS_CREDIT_RATE = 0.0165
const COFINS_CREDIT_RATE = 0.076
const ICMS_SHIPPING_CREDIT_RATE = 0.12

export function icmsDebitRate(destinationState: string, ncm: string | null): number {
  const isExemptCosmeticToParana = destinationState === 'PR' && ncm !== null && ICMS_EXEMPT_COSMETIC_NCMS.includes(ncm)
  if (isExemptCosmeticToParana) return 0
  if (destinationState === 'PR') return 0.195
  if (ICMS_TWELVE_PERCENT_STATES.includes(destinationState)) return 0.12
  return 0.07
}

export interface OrderMarginItem {
  itemValue: number
  ncm: string | null
}

export interface OrderMarginInput {
  saleAmount: number
  productCost: number | null
  commission: number
  shippingOrFeeAmount: number
  shippingOrFeeType: 'frete' | 'taxa_fixa'
  items: OrderMarginItem[]
  destinationState: string | null
  nfPending: boolean
}

export interface OrderMarginResult {
  icmsDebit: number | null
  netProfit: number | null
  marginPct: number | null
  creditPis: number
  creditCofins: number
  creditIcmsOnShipping: number
}

export function calculateOrderMargin(input: OrderMarginInput): OrderMarginResult {
  const creditPis = (input.commission + input.shippingOrFeeAmount) * PIS_CREDIT_RATE
  const creditCofins = (input.commission + input.shippingOrFeeAmount) * COFINS_CREDIT_RATE
  const creditIcmsOnShipping =
    input.shippingOrFeeType === 'frete' ? input.shippingOrFeeAmount * ICMS_SHIPPING_CREDIT_RATE : 0

  if (input.nfPending || input.destinationState === null) {
    return { icmsDebit: null, netProfit: null, marginPct: null, creditPis, creditCofins, creditIcmsOnShipping }
  }

  const destinationState = input.destinationState
  const icmsDebit = input.items.reduce(
    (sum, item) => sum + item.itemValue * icmsDebitRate(destinationState, item.ncm),
    0
  )
  const netProfit = input.saleAmount - icmsDebit - input.shippingOrFeeAmount - input.commission
  const marginPct = input.productCost === null || input.productCost === 0 ? null : (netProfit / input.productCost) * 100

  return { icmsDebit, netProfit, marginPct, creditPis, creditCofins, creditIcmsOnShipping }
}

export interface MarginPeriodSummary {
  netProfit: number
  productCost: number
  marginPct: number | null
}

export function summarizeMarginPeriod(
  orders: { netProfit: number | null; productCost: number | null }[]
): MarginPeriodSummary {
  const complete = orders.filter(
    (order): order is { netProfit: number; productCost: number } =>
      order.netProfit !== null && order.productCost !== null
  )
  const netProfit = complete.reduce((sum, order) => sum + order.netProfit, 0)
  const productCost = complete.reduce((sum, order) => sum + order.productCost, 0)
  return { netProfit, productCost, marginPct: productCost === 0 ? null : (netProfit / productCost) * 100 }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- calculateMargin
```

Expected: PASS, all cases green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/margin/calculateMargin.ts src/lib/margin/calculateMargin.test.ts
git commit -m "feat: add margin calculation module (ICMS debit, net profit, margin %)"
```

---

### Task 3: Product cost registry (data access)

**Files:**
- Create: `src/lib/margin/productCosts.ts`
- Test: `src/lib/margin/productCosts.test.ts`

**Interfaces:**
- Consumes: `product_costs` table (Task 1).
- Produces: `listProductCosts(supabase): Promise<Record<string, number>>` (maps `ml_item_id` → `cost`); `upsertProductCost(supabase, userId, mlItemId, cost): Promise<{ error: boolean }>` — both consumed by Task 7 (page) and Task 8 (cost management UI).

- [ ] **Step 1: Write the failing tests**

`src/lib/margin/productCosts.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { listProductCosts, upsertProductCost } from './productCosts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('listProductCosts', () => {
  it('returns a map of ml_item_id to cost', async () => {
    const supabase = {
      from: () => ({
        select: () =>
          Promise.resolve({
            data: [
              { ml_item_id: 'SF9004', cost: 45.5 },
              { ml_item_id: 'SF9846', cost: 20 },
            ],
            error: null,
          }),
      }),
    } as unknown as SupabaseClient

    expect(await listProductCosts(supabase)).toEqual({ SF9004: 45.5, SF9846: 20 })
  })

  it('returns an empty map when the query fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = {
      from: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }),
    } as unknown as SupabaseClient

    expect(await listProductCosts(supabase)).toEqual({})
  })
})

describe('upsertProductCost', () => {
  it('upserts a cost row scoped to the user and item', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: () => ({ upsert }) } as unknown as SupabaseClient

    const result = await upsertProductCost(supabase, 'user-1', 'SF9004', 45.5)

    expect(result).toEqual({ error: false })
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1', ml_item_id: 'SF9004', cost: 45.5 }),
      { onConflict: 'user_id,ml_item_id' }
    )
  })

  it('returns error: true when the upsert fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = {
      from: () => ({ upsert: () => Promise.resolve({ error: { message: 'boom' } }) }),
    } as unknown as SupabaseClient

    expect(await upsertProductCost(supabase, 'user-1', 'SF9004', 45.5)).toEqual({ error: true })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- productCosts
```

Expected: FAIL — `Cannot find module './productCosts'`.

- [ ] **Step 3: Implement**

`src/lib/margin/productCosts.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'

export async function listProductCosts(supabase: SupabaseClient): Promise<Record<string, number>> {
  const { data, error } = await supabase.from('product_costs').select('ml_item_id, cost')

  if (error) {
    console.error('Falha ao carregar custos de produto:', error)
    return {}
  }

  return Object.fromEntries(
    (data ?? []).map((row: { ml_item_id: string; cost: number }) => [row.ml_item_id, row.cost])
  )
}

export async function upsertProductCost(
  supabase: SupabaseClient,
  userId: string,
  mlItemId: string,
  cost: number
): Promise<{ error: boolean }> {
  const { error } = await supabase
    .from('product_costs')
    .upsert(
      { user_id: userId, ml_item_id: mlItemId, cost, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,ml_item_id' }
    )

  if (error) {
    console.error('Falha ao salvar custo de produto:', error)
    return { error: true }
  }

  return { error: false }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- productCosts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/margin/productCosts.ts src/lib/margin/productCosts.test.ts
git commit -m "feat: add product cost registry data access"
```

---

### Task 4: NF-e XML parsing + Mercado Livre client extensions

**Files:**
- Create: `src/lib/mercadolivre/nfe.ts`
- Test: `src/lib/mercadolivre/nfe.test.ts`
- Modify: `src/lib/mercadolivre/client.ts`
- Modify: `src/lib/mercadolivre/client.test.ts`

**Interfaces:**
- Consumes: nothing new (uses the existing `mlGet`/`ML_API_BASE` internals of `client.ts`).
- Produces: `parseNfeXml(xml: string): NfeInvoiceData` (`{ invoiceNumber: string; items: { productCode: string; ncm: string }[] }`); `getShipmentAddress(accessToken, shippingId): Promise<{ city: string; state: string }>`; `getShipmentSellerCost(accessToken, shippingId): Promise<number>`; `getBillingInfo(accessToken, orderId): Promise<{ buyerName: string | null }>`; `findFiscalDocumentForOrder(accessToken, orderId): Promise<{ documentItemId: string } | null>`; `downloadFiscalDocumentXml(accessToken, documentItemId): Promise<string>`; extends `MercadoLivreOrder`/`MercadoLivreOrderItem` with `saleFee`/`shippingId`/`salesChannel` — all consumed by Task 5 (sync).

**Before writing code, verify the two open questions from "Known Verification Risk" above** against a real order for the connected Mercado Livre account, if you have any way to do so in your environment (e.g., the Supabase-stored account's access token plus a direct authenticated `fetch`/`curl` to `api.mercadolibre.com`). If you cannot reach a live account from this environment either, proceed with the field names below exactly as given, and say so clearly in your report — this task's types and tests are internally consistent either way, and Task 5's manual verification step (final task of this plan) is where a human with real API access confirms or corrects them.

- [ ] **Step 1: Write the failing NF-e parser tests**

`src/lib/mercadolivre/nfe.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseNfeXml } from './nfe'

const SINGLE_ITEM_NFE = `<?xml version="1.0"?>
<nfeProc><NFe><infNFe>
  <ide><nNF>123456</nNF></ide>
  <det nItem="1"><prod><cProd>SF9004</cProd><NCM>33059000</NCM></prod></det>
</infNFe></NFe></nfeProc>`

const MULTI_ITEM_NFE = `<?xml version="1.0"?>
<nfeProc><NFe><infNFe>
  <ide><nNF>654321</nNF></ide>
  <det nItem="1"><prod><cProd>SF9004</cProd><NCM>33059000</NCM></prod></det>
  <det nItem="2"><prod><cProd>SF9846</cProd><NCM>33051000</NCM></prod></det>
</infNFe></NFe></nfeProc>`

describe('parseNfeXml', () => {
  it('parses the invoice number and the single product line of a one-item invoice', () => {
    const result = parseNfeXml(SINGLE_ITEM_NFE)
    expect(result.invoiceNumber).toBe('123456')
    expect(result.items).toEqual([{ productCode: 'SF9004', ncm: '33059000' }])
  })

  it('parses every product line of a multi-item invoice', () => {
    const result = parseNfeXml(MULTI_ITEM_NFE)
    expect(result.invoiceNumber).toBe('654321')
    expect(result.items).toEqual([
      { productCode: 'SF9004', ncm: '33059000' },
      { productCode: 'SF9846', ncm: '33051000' },
    ])
  })

  it('throws a clear error when the XML has no infNFe block', () => {
    expect(() => parseNfeXml('<not-an-nfe/>')).toThrow(/infNFe/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- nfe
```

Expected: FAIL — `Cannot find module './nfe'`.

- [ ] **Step 3: Install the XML parser and implement**

```bash
npm install fast-xml-parser
```

`src/lib/mercadolivre/nfe.ts`:

```ts
import { XMLParser } from 'fast-xml-parser'

export interface NfeInvoiceData {
  invoiceNumber: string
  items: { productCode: string; ncm: string }[]
}

const parser = new XMLParser()

export function parseNfeXml(xml: string): NfeInvoiceData {
  const parsed = parser.parse(xml)
  const infNFe = parsed.nfeProc?.NFe?.infNFe ?? parsed.NFe?.infNFe
  if (!infNFe) {
    throw new Error('XML da nota fiscal não contém o bloco infNFe esperado')
  }

  const detList = Array.isArray(infNFe.det) ? infNFe.det : [infNFe.det]

  return {
    invoiceNumber: String(infNFe.ide.nNF),
    items: detList.map((det: { prod: { cProd: string; NCM: string } }) => ({
      productCode: String(det.prod.cProd),
      ncm: String(det.prod.NCM),
    })),
  }
}
```

Note the `Array.isArray(infNFe.det)` check: a naive XML-to-object parser gives you a single object (not a one-element array) when there's only one `<det>` tag, and an array when there's more than one — this is the standard quirk of this kind of XML parsing, not a bug.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- nfe
```

Expected: PASS.

- [ ] **Step 5: Write the failing client extension tests**

Modify `src/lib/mercadolivre/client.test.ts`: extend the existing `getOrder` test's mocked JSON fixture to include the new fields, and add new `describe` blocks. The existing `getOrder` test (find it near the top of the file) currently mocks a response without `sale_fee`/`shipping`/`tags` — add them:

```ts
// In the existing 'maps the Mercado Livre order response' test, extend the mocked JSON:
global.fetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({
    id: 123,
    status: 'paid',
    total_amount: 199.9,
    currency_id: 'BRL',
    date_created: '2026-08-01T10:00:00.000-04:00',
    order_items: [
      { item: { id: 'MLB1', title: 'Produto Teste' }, quantity: 2, unit_price: 99.95, sale_fee: 18.5 },
    ],
    shipping: { id: 987654 },
    tags: ['catalog_listing_eligible'],
  }),
}) as unknown as typeof fetch

// ...and extend the assertion to also check:
// expect(order.items[0].saleFee).toBe(18.5)
// expect(order.shippingId).toBe(987654)
// expect(order.salesChannel).toBe('catalog_listing_eligible')
```

Then append these new test blocks to the same file:

```ts
describe('getShipmentAddress', () => {
  it('maps the shipment receiver address to city and state', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ receiver_address: { city: { name: 'Curitiba' }, state: { name: 'PR' } } }),
    }) as unknown as typeof fetch

    const address = await getShipmentAddress('token', 987654)

    expect(address).toEqual({ city: 'Curitiba', state: 'PR' })
  })
})

describe('getShipmentSellerCost', () => {
  it('sums the seller-side cost entries', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ senders: [{ cost: 21.15 }] }),
    }) as unknown as typeof fetch

    expect(await getShipmentSellerCost('token', 987654)).toBe(21.15)
  })
})

describe('getBillingInfo', () => {
  it('joins name and last_name when both are present', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ billing_info: { name: 'Paolla', last_name: 'Coelho' } }),
    }) as unknown as typeof fetch

    expect(await getBillingInfo('token', 123)).toEqual({ buyerName: 'Paolla Coelho' })
  })

  it('returns buyerName: null when billing_info has no name', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as unknown as typeof fetch

    expect(await getBillingInfo('token', 123)).toEqual({ buyerName: null })
  })
})

describe('findFiscalDocumentForOrder', () => {
  it('returns the first document item id when a fiscal document exists', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ items: [{ id: 'doc-item-1' }] }] }),
    }) as unknown as typeof fetch

    expect(await findFiscalDocumentForOrder('token', 123)).toEqual({ documentItemId: 'doc-item-1' })
  })

  it('returns null when no fiscal document exists yet', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) }) as unknown as typeof fetch

    expect(await findFiscalDocumentForOrder('token', 123)).toBeNull()
  })
})

describe('downloadFiscalDocumentXml', () => {
  it('returns the response body text', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => '<xml/>' }) as unknown as typeof fetch

    expect(await downloadFiscalDocumentXml('token', 'doc-item-1')).toBe('<xml/>')
  })

  it('throws when the download response is not ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch

    await expect(downloadFiscalDocumentXml('token', 'doc-item-1')).rejects.toThrow('404')
  })
})
```

Update the file's imports to include the new functions from `./client`.

- [ ] **Step 6: Run the tests to verify the new ones fail**

```bash
npm test -- client.test
```

Expected: FAIL on the new blocks (functions don't exist yet) — the modified `getOrder` test may also fail until Step 7 lands.

- [ ] **Step 7: Implement the client extensions**

In `src/lib/mercadolivre/client.ts`, modify the existing types and `toOrder`, and add the new functions:

```ts
export interface MercadoLivreOrderItem {
  mlItemId: string
  title: string
  quantity: number
  unitPrice: number
  saleFee: number
}

export interface MercadoLivreOrder {
  id: number
  status: string
  totalAmount: number
  currencyId: string
  dateCreated: string
  items: MercadoLivreOrderItem[]
  shippingId: number | null
  salesChannel: string | null
}

interface MercadoLivreOrderResponse {
  id: number
  status: string
  total_amount: number
  currency_id: string
  date_created: string
  order_items: {
    item: { id: string; title: string }
    quantity: number
    unit_price: number
    sale_fee?: number
  }[]
  shipping: { id: number } | null
  tags?: string[]
}

function toOrder(response: MercadoLivreOrderResponse): MercadoLivreOrder {
  return {
    id: response.id,
    status: response.status,
    totalAmount: response.total_amount,
    currencyId: response.currency_id,
    dateCreated: response.date_created,
    items: response.order_items.map((entry) => ({
      mlItemId: entry.item.id,
      title: entry.item.title,
      quantity: entry.quantity,
      unitPrice: entry.unit_price,
      saleFee: entry.sale_fee ?? 0,
    })),
    shippingId: response.shipping?.id ?? null,
    salesChannel: response.tags?.[0] ?? null,
  }
}

export interface MercadoLivreShipmentAddress {
  city: string
  state: string
}

interface MercadoLivreShipmentResponse {
  receiver_address: { city: { name: string }; state: { name: string } }
}

export async function getShipmentAddress(accessToken: string, shippingId: number): Promise<MercadoLivreShipmentAddress> {
  const response = await mlGet<MercadoLivreShipmentResponse>(`/shipments/${shippingId}`, accessToken)
  return { city: response.receiver_address.city.name, state: response.receiver_address.state.name }
}

interface MercadoLivreShipmentCostsResponse {
  senders: { cost: number }[]
}

export async function getShipmentSellerCost(accessToken: string, shippingId: number): Promise<number> {
  const response = await mlGet<MercadoLivreShipmentCostsResponse>(`/shipments/${shippingId}/costs`, accessToken)
  return response.senders.reduce((sum, sender) => sum + sender.cost, 0)
}

export interface MercadoLivreBillingInfo {
  buyerName: string | null
}

interface MercadoLivreBillingInfoResponse {
  billing_info?: { name?: string; last_name?: string }
}

export async function getBillingInfo(accessToken: string, orderId: number): Promise<MercadoLivreBillingInfo> {
  const response = await mlGet<MercadoLivreBillingInfoResponse>(`/orders/${orderId}/billing_info`, accessToken)
  const info = response.billing_info
  if (!info?.name) return { buyerName: null }
  return { buyerName: info.last_name ? `${info.name} ${info.last_name}` : info.name }
}

export interface MercadoLivreFiscalDocumentRef {
  documentItemId: string
}

interface MercadoLivreFiscalDocumentsResponse {
  results: { items: { id: string }[] }[]
}

export async function findFiscalDocumentForOrder(
  accessToken: string,
  orderId: number
): Promise<MercadoLivreFiscalDocumentRef | null> {
  const response = await mlGet<MercadoLivreFiscalDocumentsResponse>(`/v2/fiscalDocuments?orderId=${orderId}`, accessToken)
  const documentItemId = response.results[0]?.items[0]?.id
  return documentItemId ? { documentItemId } : null
}

export async function downloadFiscalDocumentXml(accessToken: string, documentItemId: string): Promise<string> {
  const response = await fetch(`${ML_API_BASE}/v2/fiscalDocuments/download/${documentItemId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    throw new Error(`Mercado Livre fiscal document download error: ${response.status}`)
  }
  return response.text()
}
```

- [ ] **Step 8: Run the full client test file to verify everything passes**

```bash
npm test -- client.test
```

Expected: PASS — including the pre-existing `getValidAccessToken`/`getOrder`/`searchOrders` tests, now with the extended fixture.

- [ ] **Step 9: Run the full suite**

```bash
npm test
```

Expected: all green — this task modified shared types (`MercadoLivreOrder`), so confirm nothing outside `client.test.ts` broke (nothing else references `.saleFee`/`.shippingId`/`.salesChannel` yet, so nothing else should be affected).

- [ ] **Step 10: Commit**

```bash
git add src/lib/mercadolivre/nfe.ts src/lib/mercadolivre/nfe.test.ts src/lib/mercadolivre/client.ts src/lib/mercadolivre/client.test.ts package.json package-lock.json
git commit -m "feat: add NF-e XML parsing and Mercado Livre fiscal/shipment/billing client calls"
```

---

### Task 5: Extend order sync to populate the new fields

**Files:**
- Modify: `src/lib/mercadolivre/sync.ts`
- Modify: `src/lib/mercadolivre/sync.test.ts`

**Interfaces:**
- Consumes: everything from Task 4 (`getShipmentAddress`, `getShipmentSellerCost`, `getBillingInfo`, `findFiscalDocumentForOrder`, `downloadFiscalDocumentXml`, `parseNfeXml`) plus the extended `MercadoLivreOrder` type.
- Produces: `upsertOrder`'s signature changes to `upsertOrder(supabase, accessToken, accountId, userId, order)` (adds `accessToken`) — this is a breaking change to an existing exported function, so every call site in this file updates in the same commit. Also produces `retryPendingFiscalDocuments(supabase, account): Promise<{ processed: number; errors: number }>`, consumed by Task 6.

- [ ] **Step 1: Write the failing tests for the extended `upsertOrder`**

The existing `src/lib/mercadolivre/sync.test.ts` has a shared `sampleOrder` fixture used by every describe block in the file (not just `upsertOrder`'s own tests), and mocks `client.ts` functions via `vi.spyOn(client, 'fnName')`, where `import * as client from './client'`. Two changes apply file-wide, then new test cases follow.

**File-wide change 1** — `sampleOrder` must satisfy the extended `MercadoLivreOrder` type from Task 4 (`shippingId`, `salesChannel`, each item's `saleFee`). Update it in place:

```ts
const sampleOrder: MercadoLivreOrder = {
  id: 555,
  status: 'paid',
  totalAmount: 150,
  currencyId: 'BRL',
  dateCreated: '2026-08-01T10:00:00.000-04:00',
  items: [{ mlItemId: 'MLB1', title: 'Produto', quantity: 1, unitPrice: 150, saleFee: 0 }],
  shippingId: null,
  salesChannel: null,
}
```

`shippingId: null` matters beyond type-correctness: `upsertOrder`'s new shipment-fetching branch is gated on `order.shippingId !== null`, so every pre-existing test that doesn't care about shipping data (all the `backfillOrders`/`handleMercadoLivreWebhook`/`reconcileRecentOrders` tests, which build orders from this same fixture) skips that branch entirely and needs no new mocking.

**File-wide change 2** — add a top-level `beforeEach`, since `upsertOrder` now unconditionally calls `getBillingInfo` and `findFiscalDocumentForOrder` (unlike the shipment calls, these aren't gated behind a null check) for every order it processes. Without a default mock, every pre-existing test in this file — not just new ones — would trigger a real, unmocked `fetch()` to `api.mercadolibre.com` the moment it calls `upsertOrder` (directly or via `backfillOrders`/the webhook handler/`reconcileRecentOrders`). Add this near the top of the file, after the imports:

```ts
beforeEach(() => {
  vi.spyOn(client, 'getBillingInfo').mockResolvedValue({ buyerName: null })
  vi.spyOn(client, 'findFiscalDocumentForOrder').mockResolvedValue(null)
})
```

(Add `beforeEach` to the existing `import { describe, it, expect, vi } from 'vitest'` line.) Individual tests below override either spy with `vi.spyOn(client, 'fnName').mockResolvedValue(...)` again for their specific scenario — re-spying is safe and simply replaces the default.

**Update the two existing `upsertOrder` tests** (in the `describe('upsertOrder', ...)` block) to pass the new `accessToken` argument: change both `upsertOrder(client, 'account-1', 'user-1', sampleOrder)` calls to `upsertOrder(client, 'token-abc', 'account-1', 'user-1', sampleOrder)`.

**New test cases** — add this new describe block after the existing `describe('upsertOrder', ...)`:

```ts
describe('upsertOrder - margin data', () => {
  it('stores commission as the sum of each item sale_fee', async () => {
    const { client: supabase, orderUpsertCalls } = createFakeSupabase()
    const order: MercadoLivreOrder = {
      ...sampleOrder,
      items: [
        { mlItemId: 'MLB1', title: 'Produto 1', quantity: 1, unitPrice: 169.9, saleFee: 30 },
        { mlItemId: 'MLB2', title: 'Produto 2', quantity: 1, unitPrice: 67, saleFee: 11.66 },
      ],
    }

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', order)

    expect(orderUpsertCalls[0]).toMatchObject({ data: expect.objectContaining({ ml_commission: 41.66 }) })
  })

  it('uses shipping_or_fee_type "frete" and the seller shipment cost when sale amount is >= 79', async () => {
    const { client: supabase, orderUpsertCalls } = createFakeSupabase()
    vi.spyOn(client, 'getShipmentAddress').mockResolvedValue({ city: 'Curitiba', state: 'PR' })
    const getShipmentSellerCostMock = vi.spyOn(client, 'getShipmentSellerCost').mockResolvedValue(29)
    const order: MercadoLivreOrder = { ...sampleOrder, totalAmount: 236.9, shippingId: 987654 }

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', order)

    expect(getShipmentSellerCostMock).toHaveBeenCalledWith('token-abc', 987654)
    expect(orderUpsertCalls[0]).toMatchObject({
      data: expect.objectContaining({ shipping_or_fee_type: 'frete', shipping_or_fee_amount: 29 }),
    })
  })

  it('uses shipping_or_fee_type "taxa_fixa" and does not call getShipmentSellerCost when sale amount is < 79', async () => {
    const { client: supabase, orderUpsertCalls } = createFakeSupabase()
    vi.spyOn(client, 'getShipmentAddress').mockResolvedValue({ city: 'Curitiba', state: 'PR' })
    const getShipmentSellerCostMock = vi.spyOn(client, 'getShipmentSellerCost')
    const order: MercadoLivreOrder = { ...sampleOrder, totalAmount: 50, shippingId: 987654 }

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', order)

    expect(getShipmentSellerCostMock).not.toHaveBeenCalled()
    expect(orderUpsertCalls[0]).toMatchObject({
      data: expect.objectContaining({ shipping_or_fee_type: 'taxa_fixa', shipping_or_fee_amount: 0 }),
    })
  })

  it('leaves nf_number and nf_fetched_at null and does not throw when no fiscal document is found', async () => {
    const { client: supabase, orderUpsertCalls } = createFakeSupabase()
    vi.spyOn(client, 'findFiscalDocumentForOrder').mockResolvedValue(null)

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', sampleOrder)

    expect(orderUpsertCalls[0]).toMatchObject({ data: expect.objectContaining({ nf_number: null, nf_fetched_at: null }) })
  })

  it('sets nf_number, nf_fetched_at and each item ncm when a fiscal document is found', async () => {
    const { client: supabase, orderUpsertCalls, itemsUpsertCalls } = createFakeSupabase()
    vi.spyOn(client, 'findFiscalDocumentForOrder').mockResolvedValue({ documentItemId: 'doc-item-1' })
    vi.spyOn(client, 'downloadFiscalDocumentXml').mockResolvedValue(
      '<?xml version="1.0"?><nfeProc><NFe><infNFe><ide><nNF>123456</nNF></ide>' +
        '<det nItem="1"><prod><cProd>MLB1</cProd><NCM>33059000</NCM></prod></det></infNFe></NFe></nfeProc>'
    )

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', sampleOrder)

    expect(orderUpsertCalls[0]).toMatchObject({ data: expect.objectContaining({ nf_number: '123456' }) })
    expect(orderUpsertCalls[0]).toMatchObject({ data: expect.objectContaining({ nf_fetched_at: expect.any(String) }) })
    expect(itemsUpsertCalls[0]).toMatchObject({
      data: [expect.objectContaining({ ml_item_id: 'MLB1', ncm: '33059000' })],
    })
  })

  it('leaves destination_city/state and buyer_name null without throwing when those calls fail', async () => {
    const { client: supabase, orderUpsertCalls } = createFakeSupabase()
    vi.spyOn(client, 'getShipmentAddress').mockRejectedValue(new Error('shipment not ready'))
    vi.spyOn(client, 'getBillingInfo').mockRejectedValue(new Error('billing info unavailable'))
    const order: MercadoLivreOrder = { ...sampleOrder, shippingId: 987654 }

    await expect(upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', order)).resolves.toBeUndefined()

    expect(orderUpsertCalls[0]).toMatchObject({
      data: expect.objectContaining({ destination_city: null, destination_state: null, buyer_name: null }),
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- sync.test
```

Expected: FAIL — `upsertOrder` doesn't yet accept `accessToken` or populate the new fields.

- [ ] **Step 3: Implement**

Modify `upsertOrder` in `src/lib/mercadolivre/sync.ts`:

```ts
import {
  getValidAccessToken,
  searchOrders,
  getOrder,
  getShipmentAddress,
  getShipmentSellerCost,
  getBillingInfo,
  findFiscalDocumentForOrder,
  downloadFiscalDocumentXml,
} from './client'
import { parseNfeXml } from './nfe'

const FREE_SHIPPING_THRESHOLD = 79

export async function upsertOrder(
  supabase: SupabaseClient,
  accessToken: string,
  accountId: string,
  userId: string,
  order: MercadoLivreOrder
): Promise<void> {
  const commission = order.items.reduce((sum, item) => sum + item.saleFee, 0)
  const shippingOrFeeType: 'frete' | 'taxa_fixa' =
    order.totalAmount >= FREE_SHIPPING_THRESHOLD ? 'frete' : 'taxa_fixa'

  let shippingOrFeeAmount = 0
  let destinationCity: string | null = null
  let destinationState: string | null = null
  if (order.shippingId !== null) {
    try {
      const address = await getShipmentAddress(accessToken, order.shippingId)
      destinationCity = address.city
      destinationState = address.state
      if (shippingOrFeeType === 'frete') {
        shippingOrFeeAmount = await getShipmentSellerCost(accessToken, order.shippingId)
      }
    } catch {
      // Shipment data not available yet or the call failed. Leave the
      // destination/shipping fields null/0 - the reconciliation retry
      // (retryPendingFiscalDocuments does not cover this path, only NF; a
      // later order-level reconciliation pass will re-upsert and try again).
    }
  }

  let buyerName: string | null = null
  try {
    buyerName = (await getBillingInfo(accessToken, order.id)).buyerName
  } catch {
    // Buyer billing info can be genuinely unavailable; never block the sync on it.
  }

  let nfNumber: string | null = null
  let nfFetchedAt: string | null = null
  let ncmByItemCode: Record<string, string> = {}
  try {
    const fiscalDocument = await findFiscalDocumentForOrder(accessToken, order.id)
    if (fiscalDocument) {
      const xml = await downloadFiscalDocumentXml(accessToken, fiscalDocument.documentItemId)
      const invoice = parseNfeXml(xml)
      nfNumber = invoice.invoiceNumber
      nfFetchedAt = new Date().toISOString()
      ncmByItemCode = Object.fromEntries(invoice.items.map((item) => [item.productCode, item.ncm]))
    }
  } catch {
    // No fiscal document yet is expected, not an error - nf_fetched_at stays
    // null and retryPendingFiscalDocuments (Task 6) tries again later.
  }

  const { data: orderRow, error: orderError } = await supabase
    .from('orders')
    .upsert(
      {
        account_id: accountId,
        user_id: userId,
        ml_order_id: order.id,
        status: order.status,
        total_amount: order.totalAmount,
        currency_id: order.currencyId,
        order_date: order.dateCreated,
        updated_at: new Date().toISOString(),
        ml_commission: commission,
        shipping_or_fee_amount: shippingOrFeeAmount,
        shipping_or_fee_type: shippingOrFeeType,
        destination_city: destinationCity,
        destination_state: destinationState,
        buyer_name: buyerName,
        sales_channel: order.salesChannel,
        nf_number: nfNumber,
        nf_fetched_at: nfFetchedAt,
      },
      { onConflict: 'account_id,ml_order_id' }
    )
    .select('id')
    .single()

  if (orderError) {
    throw new Error(`Falha ao gravar pedido ${order.id}: ${orderError.message}`)
  }

  if (order.items.length === 0) {
    return
  }

  const itemRows = order.items.map((item) => ({
    order_id: orderRow.id,
    user_id: userId,
    ml_item_id: item.mlItemId,
    title: item.title,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    ncm: ncmByItemCode[item.mlItemId] ?? null,
  }))

  const { error: itemsError } = await supabase
    .from('order_items')
    .upsert(itemRows, { onConflict: 'order_id,ml_item_id' })

  if (itemsError) {
    throw new Error(`Falha ao gravar itens do pedido ${order.id}: ${itemsError.message}`)
  }
}
```

**Update every call site in this file** to pass `accessToken` (all three already have it in scope as a local variable):
- `syncOrdersWindow`: change `await upsertOrder(supabase, account.id, account.userId, order)` to `await upsertOrder(supabase, accessToken, account.id, account.userId, order)`.
- `handleMercadoLivreWebhook`: change `await upsertOrder(supabase, storedAccount.id, storedAccount.userId, order)` to `await upsertOrder(supabase, accessToken, storedAccount.id, storedAccount.userId, order)`.

Now add `retryPendingFiscalDocuments` (Task 6 wires this into the cron; write it here since it lives in the same file and reuses the fiscal-document-fetch logic pattern above):

```ts
export async function retryPendingFiscalDocuments(
  supabase: SupabaseClient,
  account: StoredMercadoLivreAccount
): Promise<{ processed: number; errors: number }> {
  let processed = 0
  let errors = 0
  let lastError: string | undefined

  try {
    const accessToken = await getValidAccessToken(account, await persistRefreshedTokens(supabase, account.id))

    const { data: pendingOrders, error: queryError } = await supabase
      .from('orders')
      .select('id, ml_order_id')
      .eq('account_id', account.id)
      .is('nf_fetched_at', null)

    if (queryError) {
      throw new Error(queryError.message)
    }

    for (const pendingOrder of pendingOrders ?? []) {
      try {
        const fiscalDocument = await findFiscalDocumentForOrder(accessToken, pendingOrder.ml_order_id)
        if (!fiscalDocument) continue // still not issued - try again on a later pass, not an error

        const xml = await downloadFiscalDocumentXml(accessToken, fiscalDocument.documentItemId)
        const invoice = parseNfeXml(xml)
        const ncmByItemCode = Object.fromEntries(invoice.items.map((item) => [item.productCode, item.ncm]))

        await supabase
          .from('orders')
          .update({ nf_number: invoice.invoiceNumber, nf_fetched_at: new Date().toISOString() })
          .eq('id', pendingOrder.id)

        const { data: items } = await supabase.from('order_items').select('id, ml_item_id').eq('order_id', pendingOrder.id)
        for (const item of items ?? []) {
          const ncm = ncmByItemCode[item.ml_item_id]
          if (ncm) {
            await supabase.from('order_items').update({ ncm }).eq('id', item.id)
          }
        }

        processed += 1
      } catch (error) {
        errors += 1
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
  } catch (error) {
    errors += 1
    lastError = error instanceof Error ? error.message : String(error)
  }

  await recordSyncRun(supabase, account.id, account.userId, 'reconciliation', { processed, errors, lastError })
  return { processed, errors }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- sync.test
```

Expected: PASS, including all pre-existing `sync.test.ts` cases (updated for the new `upsertOrder` signature where they call it directly) and the new cases from Step 1.

- [ ] **Step 5: Run the full suite and build**

```bash
npm test
npm run build
```

Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mercadolivre/sync.ts src/lib/mercadolivre/sync.test.ts
git commit -m "feat: fetch and store commission, shipping, destination, buyer and NF/NCM data during order sync"
```

---

### Task 6: Wire the fiscal document retry into the reconciliation cron

**Files:**
- Modify: `src/lib/mercadolivre/cron.ts`

**Interfaces:**
- Consumes: `retryPendingFiscalDocuments` (Task 5).
- Produces: nothing new consumed by later tasks — this closes the loop for orders whose invoice wasn't ready at sync time.

- [ ] **Step 1: Add the retry call to the existing cron loop**

Modify `src/lib/mercadolivre/cron.ts`:

```ts
import cron from 'node-cron'
import { createServiceClient } from '@/lib/supabase/server'
import { reconcileRecentOrders, retryPendingFiscalDocuments, type StoredMercadoLivreAccount } from './sync'

export function startReconciliationCron() {
  cron.schedule('*/15 * * * *', async () => {
    const supabase = createServiceClient()
    const { data: accounts } = await supabase
      .from('marketplace_accounts')
      .select('*')
      .eq('marketplace', 'mercado_livre')

    for (const row of accounts ?? []) {
      const account: StoredMercadoLivreAccount = {
        id: row.id,
        userId: row.user_id,
        mlUserId: row.ml_user_id,
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        tokenExpiresAt: row.token_expires_at,
      }
      await reconcileRecentOrders(supabase, account, 2)
      await retryPendingFiscalDocuments(supabase, account)
    }
  })
}
```

There is no existing test file for `cron.ts` (it's a thin scheduling wrapper with no unit tests in this project today) — this task doesn't add one, consistent with that.

- [ ] **Step 2: Run the full suite and build**

```bash
npm test
npm run build
```

Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add src/lib/mercadolivre/cron.ts
git commit -m "feat: retry pending fiscal document fetches on the reconciliation cron"
```

---

### Task 7: Margem de contribuição page

**Files:**
- Create: `src/app/(dashboard)/margem-contribuicao/page.tsx`
- Modify: `src/components/AppSidebar.tsx`

**Interfaces:**
- Consumes: `listProductCosts` (Task 3), `calculateOrderMargin`/`summarizeMarginPeriod` (Task 2), existing `createServerSupabaseClient`.
- Produces: a real `/margem-contribuicao` route; the sidebar's "Margem de contribuição" item becomes a real link like "Vendas" (the other six placeholders — Produtos, Estoque, Anúncios, Financeiro, Integrações, Configurações — stay disabled).

- [ ] **Step 1: Enable the sidebar link**

In `src/components/AppSidebar.tsx`, change the `Margem de contribuição` entry's `href` from `null` to `'/margem-contribuicao'` (it will now take the same `<Link>`/highlighted-button branch as `Vendas` in the existing conditional). No test change needed here — `AppSidebar.test.tsx`'s existing assertion loop already only checks the *other* six items are disabled with no href; add one line confirming `Margem de contribuição` also renders as a real link, matching how the existing test checks `Vendas`:

```ts
// Add to AppSidebar.test.tsx's existing test, alongside the Vendas assertion:
const margemLink = screen.getByRole('link', { name: /Margem de contribuição/ })
expect(margemLink.getAttribute('href')).toBe('/margem-contribuicao')
```

Run `npm test -- AppSidebar` — expect FAIL until Step 1's `href` change lands, then PASS after.

- [ ] **Step 2: Build the page**

`src/app/(dashboard)/margem-contribuicao/page.tsx`:

```tsx
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { listProductCosts } from '@/lib/margin/productCosts'
import { calculateOrderMargin, summarizeMarginPeriod } from '@/lib/margin/calculateMargin'
import { formatCurrencyBRL } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { isSameMonth, subMonths } from 'date-fns'

interface OrderRow {
  id: string
  orderDate: string
  mlOrderId: number
  nfNumber: string | null
  buyerName: string | null
  destinationCity: string | null
  destinationState: string | null
  salesChannel: string | null
  saleAmount: number
  commission: number
  shippingOrFeeAmount: number
  shippingOrFeeType: 'frete' | 'taxa_fixa'
  nfPending: boolean
  items: { itemValue: number; ncm: string | null; mlItemId: string; title: string; quantity: number }[]
}

export default async function MargemContribuicaoPage() {
  const supabase = await createServerSupabaseClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold">Margem de contribuição</h1>
        <p className="text-sm text-muted-foreground">Faça login para ver seus dados.</p>
      </div>
    )
  }

  const [{ data: orders, error }, productCosts] = await Promise.all([
    supabase
      .from('orders')
      .select(
        'id, ml_order_id, order_date, total_amount, ml_commission, shipping_or_fee_amount, shipping_or_fee_type, ' +
          'destination_state, destination_city, buyer_name, sales_channel, nf_number, nf_fetched_at, ' +
          'order_items(ml_item_id, title, quantity, unit_price, ncm)'
      )
      .order('order_date', { ascending: false }),
    listProductCosts(supabase),
  ])

  const rows: OrderRow[] = (orders ?? []).map((order) => ({
    id: order.id,
    orderDate: order.order_date,
    mlOrderId: order.ml_order_id,
    nfNumber: order.nf_number,
    buyerName: order.buyer_name,
    destinationCity: order.destination_city,
    destinationState: order.destination_state,
    salesChannel: order.sales_channel,
    saleAmount: order.total_amount,
    commission: order.ml_commission ?? 0,
    shippingOrFeeAmount: order.shipping_or_fee_amount ?? 0,
    shippingOrFeeType: order.shipping_or_fee_type ?? 'taxa_fixa',
    nfPending: order.nf_fetched_at === null,
    items: (order.order_items ?? []).map((item: { ml_item_id: string; title: string; quantity: number; unit_price: number; ncm: string | null }) => ({
      itemValue: item.unit_price * item.quantity,
      ncm: item.ncm,
      mlItemId: item.ml_item_id,
      title: item.title,
      quantity: item.quantity,
    })),
  }))

  const results = rows.map((row) => {
    const productCost = row.items.reduce((sum, item) => {
      const unitCost = productCosts[item.mlItemId]
      return unitCost === undefined ? sum : sum + unitCost * item.quantity
    }, 0)
    const anyCostMissing = row.items.some((item) => productCosts[item.mlItemId] === undefined)

    const margin = calculateOrderMargin({
      saleAmount: row.saleAmount,
      productCost: anyCostMissing ? null : productCost,
      commission: row.commission,
      shippingOrFeeAmount: row.shippingOrFeeAmount,
      shippingOrFeeType: row.shippingOrFeeType,
      items: row.items.map((item) => ({ itemValue: item.itemValue, ncm: item.ncm })),
      destinationState: row.destinationState,
      nfPending: row.nfPending,
    })

    return { row, margin, productCost: anyCostMissing ? null : productCost }
  })

  const now = new Date()
  const lastMonth = subMonths(now, 1)
  const accumulated = summarizeMarginPeriod(results.map((r) => ({ netProfit: r.margin.netProfit, productCost: r.productCost })))
  const currentMonth = summarizeMarginPeriod(
    results
      .filter((r) => isSameMonth(new Date(r.row.orderDate), now))
      .map((r) => ({ netProfit: r.margin.netProfit, productCost: r.productCost }))
  )
  const previousMonth = summarizeMarginPeriod(
    results
      .filter((r) => isSameMonth(new Date(r.row.orderDate), lastMonth))
      .map((r) => ({ netProfit: r.margin.netProfit, productCost: r.productCost }))
  )

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Margem de contribuição</h1>
      {error ? <p className="text-sm text-destructive">Não foi possível carregar os pedidos.</p> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Acumulado</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{accumulated.marginPct === null ? '—' : `${accumulated.marginPct.toFixed(1)}%`}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Mês atual</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{currentMonth.marginPct === null ? '—' : `${currentMonth.marginPct.toFixed(1)}%`}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Mês anterior</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{previousMonth.marginPct === null ? '—' : `${previousMonth.marginPct.toFixed(1)}%`}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Pedido</TableHead>
                <TableHead>NF</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Cidade/UF</TableHead>
                <TableHead>Canal</TableHead>
                <TableHead>Produto(s)</TableHead>
                <TableHead className="text-right">Venda</TableHead>
                <TableHead className="text-right">Custo</TableHead>
                <TableHead className="text-right">Comissão</TableHead>
                <TableHead className="text-right">Frete/Taxa</TableHead>
                <TableHead className="text-right">Déb. ICMS</TableHead>
                <TableHead className="text-right">Lucro líquido</TableHead>
                <TableHead className="text-right">Margem %</TableHead>
                <TableHead className="text-right">Créd. PIS</TableHead>
                <TableHead className="text-right">Créd. COFINS</TableHead>
                <TableHead className="text-right">Créd. ICMS frete</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map(({ row, margin, productCost }) => (
                <TableRow key={row.id}>
                  <TableCell>{new Date(row.orderDate).toLocaleDateString('pt-BR')}</TableCell>
                  <TableCell>{row.mlOrderId}</TableCell>
                  <TableCell>{row.nfPending ? 'aguardando XML' : row.nfNumber}</TableCell>
                  <TableCell>{row.buyerName ?? '—'}</TableCell>
                  <TableCell>
                    {row.destinationCity && row.destinationState ? `${row.destinationCity}/${row.destinationState}` : '—'}
                  </TableCell>
                  <TableCell>{row.salesChannel ?? '—'}</TableCell>
                  <TableCell>{row.items.map((item) => item.title).join(', ')}</TableCell>
                  <TableCell className="text-right">{formatCurrencyBRL(row.saleAmount)}</TableCell>
                  <TableCell className="text-right">{productCost === null ? 'custo não cadastrado' : formatCurrencyBRL(productCost)}</TableCell>
                  <TableCell className="text-right">{formatCurrencyBRL(row.commission)}</TableCell>
                  <TableCell className="text-right">{formatCurrencyBRL(row.shippingOrFeeAmount)}</TableCell>
                  <TableCell className="text-right">
                    {margin.icmsDebit === null ? 'aguardando XML' : formatCurrencyBRL(margin.icmsDebit)}
                  </TableCell>
                  <TableCell className="text-right">
                    {margin.netProfit === null ? 'aguardando XML' : formatCurrencyBRL(margin.netProfit)}
                  </TableCell>
                  <TableCell className="text-right">
                    {margin.marginPct === null
                      ? productCost === null
                        ? 'custo não cadastrado'
                        : 'aguardando XML'
                      : `${margin.marginPct.toFixed(1)}%`}
                  </TableCell>
                  <TableCell className="text-right">{formatCurrencyBRL(margin.creditPis)}</TableCell>
                  <TableCell className="text-right">{formatCurrencyBRL(margin.creditCofins)}</TableCell>
                  <TableCell className="text-right">{formatCurrencyBRL(margin.creditIcmsOnShipping)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 3: Run the full suite and build**

```bash
npm test
npm run build
```

Expected: both succeed.

- [ ] **Step 4: Verify manually**

```bash
npm run dev
```

Log in, click "Margem de contribuição" in the sidebar, confirm the page loads with the three summary cards and the table (even if every row currently shows "custo não cadastrado" and/or "aguardando XML" — that's the expected state before Task 8 lets the owner register any costs and before any order has synced NF data through Task 5). Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/margem-contribuicao" src/components/AppSidebar.tsx src/components/AppSidebar.test.tsx
git commit -m "feat: add Margem de contribuicao page and enable its sidebar link"
```

---

### Task 8: Product cost management UI

**Files:**
- Create: `src/components/ProductCostForm.tsx`
- Test: `src/components/ProductCostForm.test.tsx`
- Modify: `src/app/(dashboard)/margem-contribuicao/page.tsx`

**Interfaces:**
- Consumes: `upsertProductCost` (Task 3), `createBrowserSupabaseClient` (existing).
- Produces: `ProductCostForm({ userId }: { userId: string })` — a small client component rendered on the Margem de contribuição page, letting the owner type a SKU and a cost and save it.

- [ ] **Step 1: Write the failing test**

`src/components/ProductCostForm.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ProductCostForm } from './ProductCostForm'
import * as browserClient from '@/lib/supabase/browser'
import * as productCostsModule from '@/lib/margin/productCosts'

describe('ProductCostForm', () => {
  beforeEach(() => {
    vi.spyOn(browserClient, 'createBrowserSupabaseClient').mockReturnValue({} as never)
  })

  it('saves the SKU and cost typed into the form', async () => {
    const upsertSpy = vi.spyOn(productCostsModule, 'upsertProductCost').mockResolvedValue({ error: false })

    render(<ProductCostForm userId="user-1" />)

    fireEvent.change(screen.getByLabelText('SKU do produto'), { target: { value: 'SF9004' } })
    fireEvent.change(screen.getByLabelText('Custo (R$)'), { target: { value: '45.50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar custo' }))

    await waitFor(() => {
      expect(upsertSpy).toHaveBeenCalledWith(expect.anything(), 'user-1', 'SF9004', 45.5)
    })
    expect(screen.getByText('Custo salvo.')).toBeTruthy()
  })

  it('shows an error message when saving fails', async () => {
    vi.spyOn(productCostsModule, 'upsertProductCost').mockResolvedValue({ error: true })

    render(<ProductCostForm userId="user-1" />)

    fireEvent.change(screen.getByLabelText('SKU do produto'), { target: { value: 'SF9004' } })
    fireEvent.change(screen.getByLabelText('Custo (R$)'), { target: { value: '45.50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar custo' }))

    await waitFor(() => {
      expect(screen.getByText('Não foi possível salvar o custo. Tente novamente.')).toBeTruthy()
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- ProductCostForm
```

Expected: FAIL — `Cannot find module './ProductCostForm'`.

- [ ] **Step 3: Implement**

`src/components/ProductCostForm.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { createBrowserSupabaseClient } from '@/lib/supabase/browser'
import { upsertProductCost } from '@/lib/margin/productCosts'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

export function ProductCostForm({ userId }: { userId: string }) {
  const [mlItemId, setMlItemId] = useState('')
  const [cost, setCost] = useState('')
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle')

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const supabase = createBrowserSupabaseClient()
    const parsedCost = Number(cost)
    const result = await upsertProductCost(supabase, userId, mlItemId, parsedCost)
    setStatus(result.error ? 'error' : 'saved')
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <label htmlFor="ml-item-id" className="text-sm">
          SKU do produto
        </label>
        <Input id="ml-item-id" value={mlItemId} onChange={(event) => setMlItemId(event.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="cost" className="text-sm">
          Custo (R$)
        </label>
        <Input id="cost" type="number" step="0.01" value={cost} onChange={(event) => setCost(event.target.value)} />
      </div>
      <Button type="submit">Salvar custo</Button>
      {status === 'saved' ? <p className="text-sm text-muted-foreground">Custo salvo.</p> : null}
      {status === 'error' ? <p className="text-sm text-destructive">Não foi possível salvar o custo. Tente novamente.</p> : null}
    </form>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- ProductCostForm
```

Expected: PASS, both cases green.

- [ ] **Step 5: Wire it into the page**

In `src/app/(dashboard)/margem-contribuicao/page.tsx`, import `ProductCostForm` and render `<ProductCostForm userId={user.id} />` between the `<h1>` and the summary cards.

- [ ] **Step 6: Run the full suite and build**

```bash
npm test
npm run build
```

Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add src/components/ProductCostForm.tsx src/components/ProductCostForm.test.tsx "src/app/(dashboard)/margem-contribuicao/page.tsx"
git commit -m "feat: add product cost registration form to the Margem de contribuicao page"
```

---

### Task 9: Final verification

**Files:** none expected (verification only).

**Interfaces:** none.

- [ ] **Step 1: Run the full automated test suite**

```bash
npm test
```

Expected: every test file passes, including everything from the dashboard-shell plan.

- [ ] **Step 2: Run a production build**

```bash
npm run build
```

Expected: succeeds.

- [ ] **Step 3: Apply and confirm the migration on the real Supabase project**

If Task 1's migration wasn't already applied there, apply it now and re-run its verification query.

- [ ] **Step 4: Flag the two open verification risks to the human**

This plan's "Known Verification Risk" section (Fiscal Documents API access, exact commission/shipping field names) cannot be closed by an implementer without a live, authenticated Mercado Livre session for the owner's real account. Report explicitly which of the two remain unconfirmed, so the owner can either test with their own login or grant temporary access for a live check before trusting the numbers on this page.

- [ ] **Step 5: Manual smoke test (requires the owner's real login and a Mercado Livre account with at least one synced order)**

Log in, register a product cost for a SKU that appears in a real order, and confirm that order's row shows a computed margin instead of "custo não cadastrado". If any order shows "aguardando XML" indefinitely across several reconciliation cycles (15+ minutes apart), that's the moment to check whether the Fiscal Documents API call is silently failing (permissions) rather than genuinely waiting on an unissued invoice — check the `sync_runs` table's `last_error` for that account.

This closes the "P" (Plano) stage. Per the project's standing workflow, the next stage is "A" (Auditoria): run `/code-review` and a security review over this branch before shipping to `main` — pay particular attention to the new `product_costs` RLS policy (the first owner-writable table in this project) and to whether the NF-e XML parser handles malformed/unexpected XML without crashing the sync pipeline.
