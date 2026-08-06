# Integração com a Omie para NCM e ICMS por CNPJ — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken Mercado Livre Fiscal Documents lookup with a direct integration to Omie (the owner's ERP) to get each order's NCM and invoice number, and make the ICMS debit calculation dispatch to the correct rate table (matriz vs. filial CNPJ) based on whether the order was Mercado Envios Full.

**Architecture:** A new `src/lib/omie/client.ts` module calls Omie's `ConsultarNF` (direct lookup by integration code) with a `ListarNF` (date-window scan) fallback, choosing between two Omie accounts (matriz/filial) by a new `orders.logistic_type` column captured from the Mercado Livre shipment response already fetched during sync. `calculateMargin.ts`'s `icmsDebitRate` gains a `cnpj` parameter dispatching to one of two rate tables. The old Mercado Livre Fiscal Documents API code (`findFiscalDocumentForOrder`, `downloadFiscalDocumentXml`, the NF-e XML parser) is deleted.

**Tech Stack:** Next.js 15 (App Router) + TypeScript, Supabase (Postgres + `@supabase/supabase-js`), Vitest for tests, plain `fetch` for the Omie HTTP calls (no SDK).

## Global Constraints

- **Mercado Livre only.** No other marketplace is touched by this plan.
- **Read-only.** Every Mercado Livre and Omie call in this plan is a read (`GET`/`ConsultarNF`/`ListarNF`). No write endpoint is implemented or scaffolded against either API.
- **No XML/DANFE file storage.** Only the extracted fields (NCM, invoice number) are persisted — never the raw invoice document.
- **No settings UI for Omie credentials.** Both accounts' App Key/App Secret are environment variables only, read the same way `SUPABASE_SERVICE_ROLE_KEY` is today (`process.env.X!`, server-only).
- **Ships to `main` directly, not pushed to `origin` until the owner asks** — this repo's established convention (confirmed via `git log`/`git status`: 38 local commits ahead of `origin/main`, none pushed).
- **Exact Omie response field names/nesting are unconfirmed against a live account** — this is a known, spec-flagged verification risk (see Task 3 and Task 9), not an oversight.

---

## File Structure

| File | Change |
|---|---|
| `supabase/migrations/0005_logistic_type.sql` | Create — adds `orders.logistic_type` |
| `src/lib/margin/calculateMargin.ts` | Modify — `BillingCnpj` type, `icmsDebitRateMatriz`/`icmsDebitRateFilial`, `icmsDebitRate(cnpj, ...)`, `OrderMarginInput.cnpj` |
| `src/lib/margin/calculateMargin.test.ts` | Modify — update all `icmsDebitRate` calls, add filial coverage |
| `src/lib/omie/client.ts` | Create — `lookupInvoice(account, mlOrderId, orderDate)` |
| `src/lib/omie/client.test.ts` | Create |
| `src/lib/mercadolivre/client.ts` | Modify (Task 4: add `logisticType` to `getShipmentAddress`) then Modify (Task 7: delete `findFiscalDocumentForOrder`/`downloadFiscalDocumentXml`) |
| `src/lib/mercadolivre/client.test.ts` | Modify (Task 4, Task 7) |
| `src/lib/mercadolivre/sync.ts` | Modify (Task 5: `upsertOrder`) then Modify (Task 6: `retryPendingFiscalDocuments`) then Modify (Task 7: drop dead imports) |
| `src/lib/mercadolivre/sync.test.ts` | Modify (Task 5, Task 6) |
| `src/lib/mercadolivre/nfe.ts` | Delete (Task 7) |
| `src/lib/mercadolivre/nfe.test.ts` | Delete (Task 7) |
| `package.json` | Modify (Task 7: drop `fast-xml-parser`) |
| `.env.example` | Modify (Task 3: add 4 Omie vars) |
| `src/app/(dashboard)/margem-contribuicao/page.tsx` | Modify (Task 8: thread `cnpj` through) |

---

### Task 1: Database migration — `orders.logistic_type`

**Files:**
- Create: `supabase/migrations/0005_logistic_type.sql`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `public.orders.logistic_type text` (nullable) — consumed by Task 5 (write), Task 6 (read), Task 8 (read).

- [ ] **Step 1: Write the migration**

`supabase/migrations/0005_logistic_type.sql`:

```sql
-- The Omie account to query for an order's invoice (matriz vs filial), and
-- which ICMS rate table applies, both depend on whether Mercado Livre
-- fulfilled the order (Mercado Envios Full, issued by the filial CNPJ) or
-- not (issued by the matriz CNPJ). Captured from the same /shipments/{id}
-- response already fetched for destination_state/destination_city, so it
-- shares that pair's nullable lifecycle (null until the shipment is fetched).
alter table public.orders
  add column logistic_type text;
```

- [ ] **Step 2: Apply the migration**

Use the Supabase MCP tools if available in your environment (`mcp__plugin_supabase_supabase__apply_migration` with project_id `lrscmdpaprfsprgceymz`, name `logistic_type`, and this file's SQL as `query`); otherwise apply it via the Supabase Dashboard's SQL Editor (Dashboard → SQL Editor → paste → Run).

- [ ] **Step 3: Verify**

Run (via `execute_sql` or the SQL Editor):

```sql
select column_name, is_nullable, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'orders' and column_name = 'logistic_type';
```

Expected: one row, `is_nullable = 'YES'`, `data_type = 'text'`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0005_logistic_type.sql
git commit -m "feat: add orders.logistic_type column"
```

---

### Task 2: `calculateMargin.ts` — filial ICMS rate table + `cnpj` dispatch

**Files:**
- Modify: `src/lib/margin/calculateMargin.ts`
- Modify: `src/lib/margin/calculateMargin.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions, no I/O).
- Produces: `export type BillingCnpj = 'matriz' | 'filial'`; `icmsDebitRate(cnpj: BillingCnpj, destinationState: string, ncm: string | null): number | null` (signature changed — `cnpj` is now the first parameter); `OrderMarginInput.cnpj: BillingCnpj` (new required field) — consumed by Task 8 (`page.tsx`).

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `src/lib/margin/calculateMargin.test.ts` with:

```ts
import { describe, it, expect } from 'vitest'
import { icmsDebitRate, calculateOrderMargin, summarizeMarginPeriod } from './calculateMargin'

describe('icmsDebitRate - matriz', () => {
  it('is 0% for a Parana destination with an exempt cosmetic NCM', () => {
    expect(icmsDebitRate('matriz', 'PR', '33059000')).toBe(0)
    expect(icmsDebitRate('matriz', 'PR', '33051000')).toBe(0)
  })

  it('is 19.5% for a Parana destination with a non-exempt NCM', () => {
    expect(icmsDebitRate('matriz', 'PR', '12345678')).toBe(0.195)
  })

  it('is 19.5% for a Parana destination with no NCM known yet', () => {
    expect(icmsDebitRate('matriz', 'PR', null)).toBe(0.195)
  })

  it('is 12% for MG, SP, RJ, SC and RS regardless of NCM', () => {
    for (const state of ['MG', 'SP', 'RJ', 'SC', 'RS']) {
      expect(icmsDebitRate('matriz', state, '33059000')).toBe(0.12)
      expect(icmsDebitRate('matriz', state, null)).toBe(0.12)
    }
  })

  it('is 7% for any other state', () => {
    expect(icmsDebitRate('matriz', 'BA', null)).toBe(0.07)
    expect(icmsDebitRate('matriz', 'AM', '33059000')).toBe(0.07)
  })

  it('returns null for an unrecognized destination instead of guessing a default rate', () => {
    expect(icmsDebitRate('matriz', 'São Paulo', null)).toBeNull()
    expect(icmsDebitRate('matriz', 'XX', '33059000')).toBeNull()
    expect(icmsDebitRate('matriz', '', null)).toBeNull()
  })
})

describe('icmsDebitRate - filial', () => {
  it('is 18% for SP', () => {
    expect(icmsDebitRate('filial', 'SP', null)).toBe(0.18)
    expect(icmsDebitRate('filial', 'SP', '33059000')).toBe(0.18)
  })

  it('is 12% for PR, RS, SC, RJ and MG, ignoring NCM (no cosmetic exemption on this table)', () => {
    for (const state of ['PR', 'RS', 'SC', 'RJ', 'MG']) {
      expect(icmsDebitRate('filial', state, null)).toBe(0.12)
      expect(icmsDebitRate('filial', state, '33059000')).toBe(0.12)
    }
  })

  it('is 7% for any other state', () => {
    expect(icmsDebitRate('filial', 'BA', null)).toBe(0.07)
    expect(icmsDebitRate('filial', 'AM', '33059000')).toBe(0.07)
  })

  it('returns null for an unrecognized destination', () => {
    expect(icmsDebitRate('filial', 'São Paulo', null)).toBeNull()
    expect(icmsDebitRate('filial', 'XX', null)).toBeNull()
    expect(icmsDebitRate('filial', '', null)).toBeNull()
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
    cnpj: 'matriz' as const,
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

  it('returns marginPct: null when product cost is registered as zero, without affecting netProfit', () => {
    const result = calculateOrderMargin({ ...baseInput, productCost: 0 })
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

  it('returns icmsDebit, netProfit and marginPct: null when destinationState is an unrecognized value (e.g. a full state name), while still computing the three credits', () => {
    const result = calculateOrderMargin({ ...baseInput, destinationState: 'São Paulo' })
    expect(result.icmsDebit).toBeNull()
    expect(result.netProfit).toBeNull()
    expect(result.marginPct).toBeNull()
    expect(result.creditPis).toBeCloseTo((41.66 + 29) * 0.0165, 6)
    expect(result.creditCofins).toBeCloseTo((41.66 + 29) * 0.076, 6)
    expect(result.creditIcmsOnShipping).toBeCloseTo(29 * 0.12, 6)
  })

  it('returns icmsDebit, netProfit and marginPct: null when destinationState is an unrecognized two-letter code', () => {
    const result = calculateOrderMargin({ ...baseInput, destinationState: 'XX' })
    expect(result.icmsDebit).toBeNull()
    expect(result.netProfit).toBeNull()
    expect(result.marginPct).toBeNull()
  })

  it('applies the 0% exempt rate to a Parana order for the cosmetic NCM', () => {
    const result = calculateOrderMargin({ ...baseInput, destinationState: 'PR' })
    expect(result.icmsDebit).toBe(0)
  })

  it('sums ICMS per item using each item\'s own NCM, not one rate for the whole order', () => {
    const result = calculateOrderMargin({
      ...baseInput,
      destinationState: 'PR',
      items: [
        { itemValue: 169.9, ncm: '33059000' }, // exempt cosmetic -> 0%
        { itemValue: 67, ncm: '12345678' },    // non-exempt -> 19.5%
      ],
    })
    expect(result.icmsDebit).toBeCloseTo(13.065, 3) // 169.9*0 + 67*0.195
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

  it('selects the filial rate table when cnpj is "filial", instead of the matriz table', () => {
    // Matriz would apply 19.5% to PR with a non-exempt NCM (12345678); filial
    // applies its own flat 12% for PR regardless of NCM.
    const result = calculateOrderMargin({
      ...baseInput,
      cnpj: 'filial',
      destinationState: 'PR',
      items: [{ itemValue: 100, ncm: '12345678' }],
    })
    expect(result.icmsDebit).toBeCloseTo(12, 3) // 100 * 0.12
  })

  it('keeps the matriz table (including the PR cosmetic-NCM exemption) when cnpj is "matriz"', () => {
    const result = calculateOrderMargin({
      ...baseInput,
      cnpj: 'matriz',
      destinationState: 'PR',
      items: [{ itemValue: 100, ncm: '33059000' }],
    })
    expect(result.icmsDebit).toBe(0)
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

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- calculateMargin`
Expected: FAIL — `icmsDebitRate` still takes 2 args, `OrderMarginInput` has no `cnpj` field, `BillingCnpj` is not exported.

- [ ] **Step 3: Implement**

Replace the full contents of `src/lib/margin/calculateMargin.ts` with:

```ts
const ICMS_TWELVE_PERCENT_STATES = ['MG', 'SP', 'RJ', 'SC', 'RS']
const ICMS_EXEMPT_COSMETIC_NCMS = ['33059000', '33051000']
const ICMS_FILIAL_TWELVE_PERCENT_STATES = ['PR', 'RS', 'SC', 'RJ', 'MG']
const PIS_CREDIT_RATE = 0.0165
const COFINS_CREDIT_RATE = 0.076
const ICMS_SHIPPING_CREDIT_RATE = 0.12

const VALID_UFS = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG',
  'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
]

export type BillingCnpj = 'matriz' | 'filial'

function icmsDebitRateMatriz(destinationState: string, ncm: string | null): number | null {
  if (!VALID_UFS.includes(destinationState)) return null
  const isExemptCosmeticToParana = destinationState === 'PR' && ncm !== null && ICMS_EXEMPT_COSMETIC_NCMS.includes(ncm)
  if (isExemptCosmeticToParana) return 0
  if (destinationState === 'PR') return 0.195
  if (ICMS_TWELVE_PERCENT_STATES.includes(destinationState)) return 0.12
  return 0.07
}

function icmsDebitRateFilial(destinationState: string): number | null {
  if (!VALID_UFS.includes(destinationState)) return null
  if (destinationState === 'SP') return 0.18
  if (ICMS_FILIAL_TWELVE_PERCENT_STATES.includes(destinationState)) return 0.12
  return 0.07
}

export function icmsDebitRate(cnpj: BillingCnpj, destinationState: string, ncm: string | null): number | null {
  return cnpj === 'filial' ? icmsDebitRateFilial(destinationState) : icmsDebitRateMatriz(destinationState, ncm)
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
  cnpj: BillingCnpj
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

  const isValidDestination = input.destinationState !== null && VALID_UFS.includes(input.destinationState)

  if (input.nfPending || !isValidDestination) {
    return { icmsDebit: null, netProfit: null, marginPct: null, creditPis, creditCofins, creditIcmsOnShipping }
  }

  const destinationState = input.destinationState as string
  const icmsDebit = input.items.reduce(
    (sum, item) => sum + item.itemValue * (icmsDebitRate(input.cnpj, destinationState, item.ncm) ?? 0),
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- calculateMargin`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/margin/calculateMargin.ts src/lib/margin/calculateMargin.test.ts
git commit -m "feat: add filial ICMS rate table and cnpj dispatch to icmsDebitRate"
```

---

### Task 3: Omie client module

**Files:**
- Create: `src/lib/omie/client.ts`
- Create: `src/lib/omie/client.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `OMIE_MATRIZ_APP_KEY`, `OMIE_MATRIZ_APP_SECRET`, `OMIE_FILIAL_APP_KEY`, `OMIE_FILIAL_APP_SECRET` environment variables.
- Produces: `export type OmieAccount = 'matriz' | 'filial'`; `export interface OmieInvoiceItem { productCode: string; ncm: string }`; `export interface OmieInvoice { invoiceNumber: string; items: OmieInvoiceItem[] }`; `export async function lookupInvoice(account: OmieAccount, mlOrderId: number, orderDate: Date): Promise<OmieInvoice | null>` — consumed by Task 5 and Task 6.

> **Verification risk (flagged in the spec, not resolved here):** the exact field names/nesting inside Omie's `nfCadastro`/`det[]` response are unconfirmed against a real account. This task implements the parser using the field names the spec names explicitly (`NCM`, `cProd`, `nNF`) with the most plausible nesting for Omie's documented `ConsultarNF`/`ListarNF` calls. **Task 9 requires a live call to confirm this before the feature is trusted in production** — adjust the types below if the real response differs, the same way this project discovered `seller_sku` (not `seller_custom_field`) only by inspecting a real Mercado Livre response.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/omie/client.test.ts`:

```ts
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { lookupInvoice } from './client'

const originalFetch = global.fetch
const originalEnv = { ...process.env }

beforeEach(() => {
  process.env.OMIE_MATRIZ_APP_KEY = 'matriz-key'
  process.env.OMIE_MATRIZ_APP_SECRET = 'matriz-secret'
  process.env.OMIE_FILIAL_APP_KEY = 'filial-key'
  process.env.OMIE_FILIAL_APP_SECRET = 'filial-secret'
})

afterEach(() => {
  global.fetch = originalFetch
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
})

describe('lookupInvoice', () => {
  it('returns the invoice from ConsultarNF when the integration code matches directly', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        nfCadastro: {
          compl: { nNF: '123456' },
          det: [{ produto: { cProd: 'SF9004', NCM: '33059000' } }],
        },
      }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const invoice = await lookupInvoice('matriz', 2000017307031470, new Date('2026-08-01T00:00:00.000Z'))

    expect(invoice).toEqual({ invoiceNumber: '123456', items: [{ productCode: 'SF9004', ncm: '33059000' }] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({
      call: 'ConsultarNF',
      app_key: 'matriz-key',
      app_secret: 'matriz-secret',
      param: [{ cCodNFInt: '2000017307031470' }],
    })
  })

  it('falls back to ListarNF and matches by order number inside "Informações Complementares" when ConsultarNF misses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ faultstring: 'NF nao encontrada' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          nfCadastro: [
            {
              compl: { nNF: '999' },
              det: [{ produto: { cProd: 'SF9846', NCM: '33051000' } }],
              informacoesAdicionais: { obsAdicFisco: 'Pedido Mercado Livre 2000017307031470' },
            },
          ],
        }),
      })
    global.fetch = fetchMock as unknown as typeof fetch

    const invoice = await lookupInvoice('filial', 2000017307031470, new Date('2026-08-01T00:00:00.000Z'))

    expect(invoice).toEqual({ invoiceNumber: '999', items: [{ productCode: 'SF9846', ncm: '33051000' }] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const listBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(listBody).toMatchObject({
      call: 'ListarNF',
      app_key: 'filial-key',
      app_secret: 'filial-secret',
      param: [{ nDataEmiInicial: '01/08/2026', nDataEmiFinal: '11/08/2026' }],
    })
  })

  it('returns null when both ConsultarNF and the ListarNF fallback miss', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ faultstring: 'NF nao encontrada' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ nfCadastro: [] }) })
    global.fetch = fetchMock as unknown as typeof fetch

    const invoice = await lookupInvoice('matriz', 111, new Date('2026-08-01T00:00:00.000Z'))

    expect(invoice).toBeNull()
  })

  it('does not match a ListarNF note whose "Informações Complementares" does not mention the order number', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ faultstring: 'NF nao encontrada' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          nfCadastro: [
            {
              compl: { nNF: '999' },
              det: [],
              informacoesAdicionais: { obsAdicFisco: 'Pedido Mercado Livre 555' },
            },
          ],
        }),
      })
    global.fetch = fetchMock as unknown as typeof fetch

    const invoice = await lookupInvoice('matriz', 111, new Date('2026-08-01T00:00:00.000Z'))

    expect(invoice).toBeNull()
  })

  it('throws on an HTTP error from ConsultarNF', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch

    await expect(lookupInvoice('matriz', 111, new Date('2026-08-01T00:00:00.000Z'))).rejects.toThrow(
      'Omie API error on ConsultarNF: 500'
    )
  })

  it('throws on an HTTP error from ListarNF', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ faultstring: 'NF nao encontrada' }) })
      .mockResolvedValueOnce({ ok: false, status: 500 })
    global.fetch = fetchMock as unknown as typeof fetch

    await expect(lookupInvoice('matriz', 111, new Date('2026-08-01T00:00:00.000Z'))).rejects.toThrow(
      'Omie API error on ListarNF: 500'
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/omie`
Expected: FAIL — `./client` does not exist yet.

- [ ] **Step 3: Implement**

Create `src/lib/omie/client.ts`:

```ts
import 'server-only'

export type OmieAccount = 'matriz' | 'filial'

function getCredentials(account: OmieAccount): { appKey: string; appSecret: string } {
  return account === 'filial'
    ? { appKey: process.env.OMIE_FILIAL_APP_KEY!, appSecret: process.env.OMIE_FILIAL_APP_SECRET! }
    : { appKey: process.env.OMIE_MATRIZ_APP_KEY!, appSecret: process.env.OMIE_MATRIZ_APP_SECRET! }
}

const OMIE_NF_ENDPOINT = 'https://app.omie.com.br/api/v1/produtos/nfconsultar/'
const LISTAR_NF_WINDOW_DAYS = 10

export interface OmieInvoiceItem {
  productCode: string
  ncm: string
}

export interface OmieInvoice {
  invoiceNumber: string
  items: OmieInvoiceItem[]
}

// Exact nesting/casing unconfirmed against a real Omie response - see this
// plan's Task 3 note and Task 9. Verify with one real ConsultarNF call
// before trusting this in production; adjust these field names if the real
// response differs.
interface OmieNfCadastro {
  compl: { nNF: string }
  det: { produto: { cProd: string; NCM: string } }[]
  informacoesAdicionais?: { obsAdicFisco?: string }
}

interface OmieConsultarNfResponse {
  faultstring?: string
  nfCadastro?: OmieNfCadastro
}

interface OmieListarNfResponse {
  faultstring?: string
  nfCadastro?: OmieNfCadastro[]
}

async function omiePost<T>(call: string, account: OmieAccount, param: Record<string, unknown>): Promise<T> {
  const { appKey, appSecret } = getCredentials(account)
  const response = await fetch(OMIE_NF_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ call, app_key: appKey, app_secret: appSecret, param: [param] }),
  })
  if (!response.ok) {
    throw new Error(`Omie API error on ${call}: ${response.status}`)
  }
  return response.json()
}

function toInvoice(nf: OmieNfCadastro): OmieInvoice {
  return {
    invoiceNumber: String(nf.compl.nNF),
    items: nf.det.map((line) => ({ productCode: String(line.produto.cProd), ncm: String(line.produto.NCM) })),
  }
}

function formatOmieDate(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const yyyy = date.getUTCFullYear()
  return `${dd}/${mm}/${yyyy}`
}

function invoiceMentionsOrder(nf: OmieNfCadastro, mlOrderId: number): boolean {
  const text = nf.informacoesAdicionais?.obsAdicFisco ?? ''
  return text.includes(String(mlOrderId))
}

export async function lookupInvoice(
  account: OmieAccount,
  mlOrderId: number,
  orderDate: Date
): Promise<OmieInvoice | null> {
  const direct = await omiePost<OmieConsultarNfResponse>('ConsultarNF', account, {
    cCodNFInt: String(mlOrderId),
  })
  if (direct.nfCadastro) return toInvoice(direct.nfCadastro)

  const windowEnd = new Date(orderDate.getTime() + LISTAR_NF_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const list = await omiePost<OmieListarNfResponse>('ListarNF', account, {
    nDataEmiInicial: formatOmieDate(orderDate),
    nDataEmiFinal: formatOmieDate(windowEnd),
  })
  const match = (list.nfCadastro ?? []).find((nf) => invoiceMentionsOrder(nf, mlOrderId))
  return match ? toInvoice(match) : null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/omie`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Add the env vars to `.env.example`**

Append to `.env.example`:

```
# Both Omie accounts' App Key/App Secret (matriz issues everything except
# Mercado Envios Full, which the filial CNPJ issues) - used to look up each
# order's invoice for NCM/ICMS purposes. Never sent to the browser.
OMIE_MATRIZ_APP_KEY=
OMIE_MATRIZ_APP_SECRET=
OMIE_FILIAL_APP_KEY=
OMIE_FILIAL_APP_SECRET=
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/omie/client.ts src/lib/omie/client.test.ts .env.example
git commit -m "feat: add Omie client for invoice NCM/number lookup"
```

---

### Task 4: `getShipmentAddress` — return `logisticType`

**Files:**
- Modify: `src/lib/mercadolivre/client.ts`
- Modify: `src/lib/mercadolivre/client.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `MercadoLivreShipmentAddress.logisticType: string | null` — consumed by Task 5.

- [ ] **Step 1: Write the failing tests**

In `src/lib/mercadolivre/client.test.ts`, replace the `describe('getShipmentAddress', ...)` block with:

```ts
describe('getShipmentAddress', () => {
  it('extracts the two-letter UF from a "BR-XX" state id and the logistic type', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        receiver_address: { city: { name: 'Curitiba' }, state: { id: 'BR-PR', name: 'Paraná' } },
        logistic_type: 'fulfillment',
      }),
    }) as unknown as typeof fetch

    const address = await getShipmentAddress('token', 987654)

    expect(address).toEqual({ city: 'Curitiba', state: 'PR', logisticType: 'fulfillment' })
  })

  it('falls back to state.name when it is already a two-letter code and there is no id', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ receiver_address: { city: { name: 'Curitiba' }, state: { name: 'PR' } } }),
    }) as unknown as typeof fetch

    const address = await getShipmentAddress('token', 987654)

    expect(address).toEqual({ city: 'Curitiba', state: 'PR', logisticType: null })
  })

  it('falls back to the raw state.name when neither a "BR-XX" id nor a two-letter name is present', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ receiver_address: { city: { name: 'Curitiba' }, state: { name: 'Paraná' } } }),
    }) as unknown as typeof fetch

    const address = await getShipmentAddress('token', 987654)

    expect(address).toEqual({ city: 'Curitiba', state: 'Paraná', logisticType: null })
  })

  it('returns logisticType: null when the response has no logistic_type field', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ receiver_address: { city: { name: 'Curitiba' }, state: { id: 'BR-SP', name: 'São Paulo' } } }),
    }) as unknown as typeof fetch

    const address = await getShipmentAddress('token', 987654)

    expect(address.logisticType).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- client.test.ts -t getShipmentAddress`
Expected: FAIL — `toEqual` mismatches because `logisticType` is not yet in the returned object.

- [ ] **Step 3: Implement**

In `src/lib/mercadolivre/client.ts`, replace:

```ts
export interface MercadoLivreShipmentAddress {
  city: string
  state: string
}

interface MercadoLivreShipmentResponse {
  receiver_address: { city: { name: string }; state: { id?: string; name: string } }
}
```

with:

```ts
export interface MercadoLivreShipmentAddress {
  city: string
  state: string
  logisticType: string | null
}

interface MercadoLivreShipmentResponse {
  receiver_address: { city: { name: string }; state: { id?: string; name: string } }
  logistic_type?: string
}
```

and replace:

```ts
export async function getShipmentAddress(accessToken: string, shippingId: number): Promise<MercadoLivreShipmentAddress> {
  const response = await mlGet<MercadoLivreShipmentResponse>(`/shipments/${shippingId}`, accessToken)
  return { city: response.receiver_address.city.name, state: extractUf(response.receiver_address.state) }
}
```

with:

```ts
export async function getShipmentAddress(accessToken: string, shippingId: number): Promise<MercadoLivreShipmentAddress> {
  const response = await mlGet<MercadoLivreShipmentResponse>(`/shipments/${shippingId}`, accessToken)
  return {
    city: response.receiver_address.city.name,
    state: extractUf(response.receiver_address.state),
    logisticType: response.logistic_type ?? null,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- client.test.ts`
Expected: PASS, all tests in the file green (including the untouched ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/mercadolivre/client.ts src/lib/mercadolivre/client.test.ts
git commit -m "feat: return logistic_type from getShipmentAddress"
```

---

### Task 5: `sync.ts` `upsertOrder` — wire Omie lookup + persist `logistic_type`

**Files:**
- Modify: `src/lib/mercadolivre/sync.ts`
- Modify: `src/lib/mercadolivre/sync.test.ts`

**Interfaces:**
- Consumes: Task 1's `orders.logistic_type` column; Task 3's `lookupInvoice(account, mlOrderId, orderDate)`; Task 4's `MercadoLivreShipmentAddress.logisticType`.
- Produces: `orders.logistic_type` persisted at sync time; the Omie account routing rule (`logisticType === 'fulfillment' ? 'filial' : 'matriz'`) — consumed by Task 6 and Task 8, which apply the same rule from the stored column.

- [ ] **Step 1: Write the failing tests**

In `src/lib/mercadolivre/sync.test.ts`:

**1a.** Add the Omie client import after the existing `client` import:

```ts
import * as client from './client'
import * as omieClient from '../omie/client'
```

**1b.** Replace the top-level `beforeEach`:

```ts
beforeEach(() => {
  vi.spyOn(client, 'getBillingInfo').mockResolvedValue({ buyerName: null })
  vi.spyOn(omieClient, 'lookupInvoice').mockResolvedValue(null)
})
```

**1c.** Replace the `'leaves nf_number and nf_fetched_at null and does not throw when no fiscal document is found'` test with:

```ts
  it('leaves nf_number and nf_fetched_at null and does not throw when no invoice is found', async () => {
    const { client: supabase, orderUpsertCalls } = createFakeSupabase()
    vi.spyOn(omieClient, 'lookupInvoice').mockResolvedValue(null)

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', sampleOrder)

    expect(orderUpsertCalls[0]).toMatchObject({ data: expect.objectContaining({ nf_number: null, nf_fetched_at: null }) })
  })
```

**1d.** Replace the `'sets nf_number, nf_fetched_at, product_code and ncm ...'` test with:

```ts
  it('sets nf_number, nf_fetched_at, product_code and ncm (matched by product code) when an invoice is found', async () => {
    const { client: supabase, orderUpsertCalls, itemsUpsertCalls } = createFakeSupabase()
    const order: MercadoLivreOrder = {
      ...sampleOrder,
      items: [{ mlItemId: 'MLB1', title: 'Produto', quantity: 1, unitPrice: 150, saleFee: 0, sellerSku: 'SF9004' }],
    }
    // The invoice's product code ("SF9004") matches the order item's
    // sellerSku - the seller's own SKU, captured from Mercado Livre's order
    // data, is the same code the seller's ERP (OMIE) prints on the NF-e.
    vi.spyOn(omieClient, 'lookupInvoice').mockResolvedValue({
      invoiceNumber: '123456',
      items: [{ productCode: 'SF9004', ncm: '33059000' }],
    })

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', order)

    expect(orderUpsertCalls[0]).toMatchObject({ data: expect.objectContaining({ nf_number: '123456' }) })
    expect(orderUpsertCalls[0]).toMatchObject({ data: expect.objectContaining({ nf_fetched_at: expect.any(String) }) })
    expect(itemsUpsertCalls[0]).toMatchObject({
      data: [expect.objectContaining({ ml_item_id: 'MLB1', product_code: 'SF9004', ncm: '33059000' })],
    })
  })
```

**1e.** Replace the `'stores product_code from sellerSku even when no fiscal document is found yet...'` test with:

```ts
  it('stores product_code from sellerSku even when no invoice is found yet, and leaves ncm null', async () => {
    const { client: supabase, itemsUpsertCalls } = createFakeSupabase()
    vi.spyOn(omieClient, 'lookupInvoice').mockResolvedValue(null)
    const order: MercadoLivreOrder = {
      ...sampleOrder,
      items: [{ mlItemId: 'MLB1', title: 'Produto', quantity: 1, unitPrice: 150, saleFee: 0, sellerSku: 'SF9004' }],
    }

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', order)

    expect(itemsUpsertCalls[0]).toMatchObject({
      data: [expect.objectContaining({ product_code: 'SF9004', ncm: null })],
    })
  })
```

**1f.** Replace the `'matches ncm per item by product code...'` test with:

```ts
  it('matches ncm per item by product code, leaving unmatched items null, regardless of item-count differences', async () => {
    const { client: supabase, itemsUpsertCalls } = createFakeSupabase()
    // The invoice only carries NCM for SF9004 - SF9846 (a real item on this
    // order) has no matching line. Matching by code means SF9004 gets its
    // NCM correctly while SF9846 simply stays null - no guessing, no
    // dependency on the two lists having matching lengths.
    vi.spyOn(omieClient, 'lookupInvoice').mockResolvedValue({
      invoiceNumber: '123456',
      items: [{ productCode: 'SF9004', ncm: '33059000' }],
    })
    const order: MercadoLivreOrder = {
      ...sampleOrder,
      items: [
        { mlItemId: 'MLB1', title: 'Produto 1', quantity: 1, unitPrice: 169.9, saleFee: 30, sellerSku: 'SF9004' },
        { mlItemId: 'MLB2', title: 'Produto 2', quantity: 1, unitPrice: 67, saleFee: 11.66, sellerSku: 'SF9846' },
      ],
    }

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', order)

    expect(itemsUpsertCalls[0]).toMatchObject({
      data: [
        expect.objectContaining({ ml_item_id: 'MLB1', product_code: 'SF9004', ncm: '33059000' }),
        expect.objectContaining({ ml_item_id: 'MLB2', product_code: 'SF9846', ncm: null }),
      ],
    })
  })
```

**1g.** Replace the `'leaves product_code and ncm null when the item has no seller SKU set on Mercado Livre'` test with:

```ts
  it('leaves product_code and ncm null when the item has no seller SKU set on Mercado Livre', async () => {
    const { client: supabase, itemsUpsertCalls } = createFakeSupabase()
    vi.spyOn(omieClient, 'lookupInvoice').mockResolvedValue({
      invoiceNumber: '123456',
      items: [{ productCode: 'SF9004', ncm: '33059000' }],
    })
    const order: MercadoLivreOrder = {
      ...sampleOrder,
      items: [{ mlItemId: 'MLB1', title: 'Produto', quantity: 1, unitPrice: 150, saleFee: 0, sellerSku: null }],
    }

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', order)

    expect(itemsUpsertCalls[0]).toMatchObject({
      data: [expect.objectContaining({ product_code: null, ncm: null })],
    })
  })
```

**1h.** Replace the `'leaves destination_city/state and buyer_name null without throwing when those calls fail'` test with:

```ts
  it('leaves destination_city/state, logistic_type and buyer_name null without throwing when those calls fail', async () => {
    const { client: supabase, orderUpsertCalls } = createFakeSupabase()
    vi.spyOn(client, 'getShipmentAddress').mockRejectedValue(new Error('shipment not ready'))
    vi.spyOn(client, 'getBillingInfo').mockRejectedValue(new Error('billing info unavailable'))
    const order: MercadoLivreOrder = { ...sampleOrder, shippingId: 987654 }

    await expect(upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', order)).resolves.toBeUndefined()

    expect(orderUpsertCalls[0]).toMatchObject({
      data: expect.objectContaining({
        destination_city: null,
        destination_state: null,
        logistic_type: null,
        buyer_name: null,
      }),
    })
  })
```

**1i.** Add three new tests immediately after 1h (still inside `describe('upsertOrder - margin data', ...)`):

```ts
  it('stores logistic_type from the shipment response on the orders row', async () => {
    const { client: supabase, orderUpsertCalls } = createFakeSupabase()
    vi.spyOn(client, 'getShipmentAddress').mockResolvedValue({ city: 'Curitiba', state: 'PR', logisticType: 'fulfillment' })
    const order: MercadoLivreOrder = { ...sampleOrder, shippingId: 987654 }

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', order)

    expect(orderUpsertCalls[0]).toMatchObject({ data: expect.objectContaining({ logistic_type: 'fulfillment' }) })
  })

  it('looks up the invoice in the filial Omie account when logistic_type is "fulfillment"', async () => {
    const { client: supabase } = createFakeSupabase()
    vi.spyOn(client, 'getShipmentAddress').mockResolvedValue({ city: 'São Paulo', state: 'SP', logisticType: 'fulfillment' })
    const lookupInvoiceMock = vi.spyOn(omieClient, 'lookupInvoice').mockResolvedValue(null)
    const order: MercadoLivreOrder = { ...sampleOrder, shippingId: 987654 }

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', order)

    expect(lookupInvoiceMock).toHaveBeenCalledWith('filial', order.id, new Date(order.dateCreated))
  })

  it('looks up the invoice in the matriz Omie account for any logistic_type other than "fulfillment", including null', async () => {
    const { client: supabase } = createFakeSupabase()
    vi.spyOn(client, 'getShipmentAddress').mockResolvedValue({ city: 'Curitiba', state: 'PR', logisticType: 'self_service' })
    const lookupInvoiceMock = vi.spyOn(omieClient, 'lookupInvoice').mockResolvedValue(null)
    const order: MercadoLivreOrder = { ...sampleOrder, shippingId: 987654 }

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', order)

    expect(lookupInvoiceMock).toHaveBeenCalledWith('matriz', order.id, new Date(order.dateCreated))

    lookupInvoiceMock.mockClear()
    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', sampleOrder) // shippingId: null -> logisticType stays null
    expect(lookupInvoiceMock).toHaveBeenCalledWith('matriz', sampleOrder.id, new Date(sampleOrder.dateCreated))
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- sync.test.ts -t upsertOrder`
Expected: FAIL — `upsertOrder` still calls the old Mercado Livre fiscal document functions, `logistic_type` is not written, `omieClient.lookupInvoice` is never called.

- [ ] **Step 3: Implement**

In `src/lib/mercadolivre/sync.ts`, add the Omie import (keep the existing `findFiscalDocumentForOrder`/`downloadFiscalDocumentXml`/`parseNfeXml` imports for now — `retryPendingFiscalDocuments` still needs them until Task 6):

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
import { lookupInvoice } from '../omie/client'
```

Replace the destination/shipping block inside `upsertOrder`:

```ts
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
```

with:

```ts
  let shippingOrFeeAmount = 0
  let destinationCity: string | null = null
  let destinationState: string | null = null
  let logisticType: string | null = null
  if (order.shippingId !== null) {
    try {
      const address = await getShipmentAddress(accessToken, order.shippingId)
      destinationCity = address.city
      destinationState = address.state
      logisticType = address.logisticType
      if (shippingOrFeeType === 'frete') {
        shippingOrFeeAmount = await getShipmentSellerCost(accessToken, order.shippingId)
      }
    } catch {
      // Shipment data not available yet or the call failed. Leave the
      // destination/shipping/logistic_type fields null/0 - the reconciliation
      // retry (retryPendingFiscalDocuments does not cover this path, only NF; a
      // later order-level reconciliation pass will re-upsert and try again).
    }
  }
```

Replace the fiscal document block:

```ts
  let nfNumber: string | null = null
  let nfFetchedAt: string | null = null
  let ncmByProductCode: Record<string, string> = {}
  try {
    const fiscalDocument = await findFiscalDocumentForOrder(accessToken, order.id)
    if (fiscalDocument) {
      const xml = await downloadFiscalDocumentXml(accessToken, fiscalDocument.documentItemId)
      const invoice = parseNfeXml(xml)
      nfNumber = invoice.invoiceNumber
      nfFetchedAt = new Date().toISOString()
      // The invoice's <cProd> is the same code as the order item's own SKU
      // (order.items[].sellerSku, from Mercado Livre's seller_sku) - the
      // seller's ERP (OMIE) prints it on the NF-e as "CÓDIGO PRODUTO" using
      // that same value, so this is a reliable join key, not a guess.
      ncmByProductCode = Object.fromEntries(invoice.items.map((item) => [item.productCode, item.ncm]))
    }
  } catch {
    // No fiscal document yet is expected, not an error - nf_fetched_at stays
    // null and retryPendingFiscalDocuments (Task 6) tries again later.
  }
```

with:

```ts
  let nfNumber: string | null = null
  let nfFetchedAt: string | null = null
  let ncmByProductCode: Record<string, string> = {}
  try {
    const omieAccount = logisticType === 'fulfillment' ? 'filial' : 'matriz'
    const invoice = await lookupInvoice(omieAccount, order.id, new Date(order.dateCreated))
    if (invoice) {
      nfNumber = invoice.invoiceNumber
      nfFetchedAt = new Date().toISOString()
      // The invoice's product code is the same code as the order item's own
      // SKU (order.items[].sellerSku, from Mercado Livre's seller_sku) - the
      // seller's ERP (OMIE) prints it on the NF-e using that same value, so
      // this is a reliable join key, not a guess.
      ncmByProductCode = Object.fromEntries(invoice.items.map((item) => [item.productCode, item.ncm]))
    }
  } catch {
    // An Omie API failure (network error, auth failure, rate limit) must not
    // block the rest of the sync - nf_fetched_at stays null and
    // retryPendingFiscalDocuments (Task 6) retries later. A missing invoice
    // (not yet issued) does not throw at all - that's the `if (invoice)` check.
  }
```

Replace the `orders` upsert object's destination fields:

```ts
        destination_city: destinationCity,
        destination_state: destinationState,
        buyer_name: buyerName,
```

with:

```ts
        destination_city: destinationCity,
        destination_state: destinationState,
        logistic_type: logisticType,
        buyer_name: buyerName,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- sync.test.ts -t upsertOrder`
Expected: PASS, all `upsertOrder` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mercadolivre/sync.ts src/lib/mercadolivre/sync.test.ts
git commit -m "feat: wire Omie invoice lookup and logistic_type into upsertOrder"
```

---

### Task 6: `sync.ts` `retryPendingFiscalDocuments` — rewire to Omie

**Files:**
- Modify: `src/lib/mercadolivre/sync.ts`
- Modify: `src/lib/mercadolivre/sync.test.ts`

**Interfaces:**
- Consumes: Task 3's `lookupInvoice`; Task 1's `orders.logistic_type`/`order_date` columns (already existing for `order_date`).
- Produces: same `{ processed, errors }` return shape and retry/age-window behavior as before, now backed by Omie instead of the Mercado Livre Fiscal Documents API.

- [ ] **Step 1: Write the failing tests**

In `src/lib/mercadolivre/sync.test.ts`, inside `describe('retryPendingFiscalDocuments', ...)`:

**1a.** Replace the `'counts a failed orders.update write as an error...'` test with:

```ts
  it('counts a failed orders.update write as an error (not processed) and still processes the rest of the batch', async () => {
    const pendingOrders = [
      { id: 'order-fail', ml_order_id: 111, order_date: '2026-08-01T10:00:00.000Z', logistic_type: null },
      { id: 'order-ok', ml_order_id: 222, order_date: '2026-08-01T10:00:00.000Z', logistic_type: null },
    ]
    const orderUpdateErrors: Record<string, { message: string } | null> = {
      'order-fail': { message: 'update rejected by RLS' },
      'order-ok': null,
    }
    const syncRunInserts: unknown[] = []

    const supabase = {
      from(table: string) {
        if (table === 'orders') {
          return {
            select: () => ({
              eq: () => ({
                is: async () => ({ data: pendingOrders, error: null }),
              }),
            }),
            update: () => ({
              eq: async (_col: string, id: string) => ({ error: orderUpdateErrors[id] ?? null }),
            }),
          }
        }
        if (table === 'order_items') {
          return {
            select: () => ({ eq: async () => ({ data: [], error: null }) }),
            update: () => ({ eq: async () => ({ error: null }) }),
          }
        }
        if (table === 'sync_runs') {
          return {
            insert: async (data: unknown) => {
              syncRunInserts.push(data)
              return { error: null }
            },
          }
        }
        throw new Error(`Unexpected table: ${table}`)
      },
    } as unknown as SupabaseClient

    const account = {
      id: 'account-1',
      userId: 'user-1',
      mlUserId: 999,
      accessToken: 'token-abc',
      refreshToken: 'refresh-abc',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }

    vi.spyOn(client, 'getValidAccessToken').mockResolvedValue('token-abc')
    vi.spyOn(omieClient, 'lookupInvoice').mockResolvedValue({
      invoiceNumber: '999',
      items: [{ productCode: 'SF9004', ncm: '33059000' }],
    })

    const result = await retryPendingFiscalDocuments(supabase, account)

    // The failing order's write error must surface as an error, not be
    // silently swallowed and counted as a successful "processed" order - and
    // the second order in the batch must still be attempted and succeed.
    expect(result).toEqual({ processed: 1, errors: 1 })
    expect(syncRunInserts).toHaveLength(1)
    expect(syncRunInserts[0]).toMatchObject({
      orders_processed: 1,
      error_count: 1,
      last_error: 'update rejected by RLS',
    })
  })
```

**1b.** Replace the `'leaves an order untouched and does not count it as an error when no fiscal document exists yet'` test with:

```ts
  it('leaves an order untouched and does not count it as an error when no invoice exists yet', async () => {
    const orderUpdateCalls: unknown[] = []
    const supabase = {
      from(table: string) {
        if (table === 'orders') {
          return {
            select: () => ({
              eq: () => ({
                is: async () => ({
                  data: [{ id: 'order-1', ml_order_id: 111, order_date: '2026-08-01T10:00:00.000Z', logistic_type: null }],
                  error: null,
                }),
              }),
            }),
            update: (data: unknown) => ({
              eq: async (col: string, id: string) => {
                orderUpdateCalls.push({ data, col, id })
                return { error: null }
              },
            }),
          }
        }
        if (table === 'sync_runs') {
          return { insert: async () => ({ error: null }) }
        }
        throw new Error(`Unexpected table: ${table}`)
      },
    } as unknown as SupabaseClient

    const account = {
      id: 'account-1',
      userId: 'user-1',
      mlUserId: 999,
      accessToken: 'token-abc',
      refreshToken: 'refresh-abc',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }
    vi.spyOn(client, 'getValidAccessToken').mockResolvedValue('token-abc')
    vi.spyOn(omieClient, 'lookupInvoice').mockResolvedValue(null)

    const result = await retryPendingFiscalDocuments(supabase, account)

    expect(result).toEqual({ processed: 0, errors: 0 })
    expect(orderUpdateCalls).toHaveLength(0)
  })
```

**1c.** Replace the `'applies NCM by matching order_items to invoice lines by product_code'` test with:

```ts
  it('applies NCM by matching order_items to invoice lines by product_code', async () => {
    const itemUpdateCalls: { id: string; ncm: string }[] = []
    const supabase = {
      from(table: string) {
        if (table === 'orders') {
          return {
            select: () => ({
              eq: () => ({
                is: async () => ({
                  data: [{ id: 'order-1', ml_order_id: 111, order_date: '2026-08-01T10:00:00.000Z', logistic_type: null }],
                  error: null,
                }),
              }),
            }),
            update: () => ({ eq: async () => ({ error: null }) }),
          }
        }
        if (table === 'order_items') {
          return {
            select: () => ({
              eq: async () => ({
                data: [
                  { id: 'item-row-1', product_code: 'SF9004' },
                  { id: 'item-row-2', product_code: 'SF9846' },
                ],
                error: null,
              }),
            }),
            update: (data: { ncm: string }) => ({
              eq: async (_col: string, id: string) => {
                itemUpdateCalls.push({ id, ncm: data.ncm })
                return { error: null }
              },
            }),
          }
        }
        if (table === 'sync_runs') {
          return { insert: async () => ({ error: null }) }
        }
        throw new Error(`Unexpected table: ${table}`)
      },
    } as unknown as SupabaseClient

    const account = {
      id: 'account-1',
      userId: 'user-1',
      mlUserId: 999,
      accessToken: 'token-abc',
      refreshToken: 'refresh-abc',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }
    vi.spyOn(client, 'getValidAccessToken').mockResolvedValue('token-abc')
    // Invoice product codes ("SF9004", "SF9846") match the order_items rows'
    // product_code exactly (captured earlier from Mercado Livre's own
    // seller_sku), so matching is a direct lookup, not a guess.
    vi.spyOn(omieClient, 'lookupInvoice').mockResolvedValue({
      invoiceNumber: '999',
      items: [
        { productCode: 'SF9004', ncm: '33059000' },
        { productCode: 'SF9846', ncm: '33051000' },
      ],
    })

    await retryPendingFiscalDocuments(supabase, account)

    expect(itemUpdateCalls).toEqual(
      expect.arrayContaining([
        { id: 'item-row-1', ncm: '33059000' },
        { id: 'item-row-2', ncm: '33051000' },
      ])
    )
  })
```

**1d.** Replace the `'leaves an item untouched when its product_code has no matching line in the invoice'` test with:

```ts
  it('leaves an item untouched when its product_code has no matching line in the invoice', async () => {
    const itemUpdateCalls: unknown[] = []
    const supabase = {
      from(table: string) {
        if (table === 'orders') {
          return {
            select: () => ({
              eq: () => ({
                is: async () => ({
                  data: [{ id: 'order-1', ml_order_id: 111, order_date: '2026-08-01T10:00:00.000Z', logistic_type: null }],
                  error: null,
                }),
              }),
            }),
            update: () => ({ eq: async () => ({ error: null }) }),
          }
        }
        if (table === 'order_items') {
          return {
            select: () => ({
              eq: async () => ({
                data: [
                  { id: 'item-row-1', product_code: 'SF9004' },
                  { id: 'item-row-2', product_code: 'SF9846' },
                ],
                error: null,
              }),
            }),
            update: (data: { ncm: string }) => ({
              eq: async (_col: string, id: string) => {
                itemUpdateCalls.push({ id, ncm: data.ncm })
                return { error: null }
              },
            }),
          }
        }
        if (table === 'sync_runs') {
          return { insert: async () => ({ error: null }) }
        }
        throw new Error(`Unexpected table: ${table}`)
      },
    } as unknown as SupabaseClient

    const account = {
      id: 'account-1',
      userId: 'user-1',
      mlUserId: 999,
      accessToken: 'token-abc',
      refreshToken: 'refresh-abc',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }
    vi.spyOn(client, 'getValidAccessToken').mockResolvedValue('token-abc')
    // The invoice only has a line for SF9004 - SF9846 has no match and must
    // simply be left alone, not guessed at.
    vi.spyOn(omieClient, 'lookupInvoice').mockResolvedValue({
      invoiceNumber: '999',
      items: [{ productCode: 'SF9004', ncm: '33059000' }],
    })

    const result = await retryPendingFiscalDocuments(supabase, account)

    expect(result).toEqual({ processed: 1, errors: 0 })
    expect(itemUpdateCalls).toEqual([{ id: 'item-row-1', ncm: '33059000' }])
  })
```

**1e.** Replace the `'isolates a failure at the fiscal-document-fetch stage so the rest of the batch still processes'` test with:

```ts
  it('isolates a failure at the invoice-lookup stage so the rest of the batch still processes', async () => {
    const pendingOrders = [
      { id: 'order-fail', ml_order_id: 111, order_date: '2026-08-01T10:00:00.000Z', logistic_type: null },
      { id: 'order-ok', ml_order_id: 222, order_date: '2026-08-01T10:00:00.000Z', logistic_type: null },
    ]
    const supabase = {
      from(table: string) {
        if (table === 'orders') {
          return {
            select: () => ({ eq: () => ({ is: async () => ({ data: pendingOrders, error: null }) }) }),
            update: () => ({ eq: async () => ({ error: null }) }),
          }
        }
        if (table === 'order_items') {
          return {
            select: () => ({ eq: async () => ({ data: [], error: null }) }),
            update: () => ({ eq: async () => ({ error: null }) }),
          }
        }
        if (table === 'sync_runs') {
          return { insert: async () => ({ error: null }) }
        }
        throw new Error(`Unexpected table: ${table}`)
      },
    } as unknown as SupabaseClient

    const account = {
      id: 'account-1',
      userId: 'user-1',
      mlUserId: 999,
      accessToken: 'token-abc',
      refreshToken: 'refresh-abc',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }
    vi.spyOn(client, 'getValidAccessToken').mockResolvedValue('token-abc')
    const lookupInvoiceMock = vi.spyOn(omieClient, 'lookupInvoice')
    lookupInvoiceMock.mockRejectedValueOnce(new Error('Omie API error on ConsultarNF: 500'))
    lookupInvoiceMock.mockResolvedValueOnce({
      invoiceNumber: '999',
      items: [{ productCode: 'SF9004', ncm: '33059000' }],
    })

    const result = await retryPendingFiscalDocuments(supabase, account)

    expect(result).toEqual({ processed: 1, errors: 1 })
    expect(lookupInvoiceMock).toHaveBeenCalledTimes(2)
  })
```

**1f.** Add a new test after 1e for account routing:

```ts
  it('routes to the filial Omie account when logistic_type is "fulfillment" and to matriz otherwise', async () => {
    const pendingOrders = [
      { id: 'order-full', ml_order_id: 111, order_date: '2026-08-01T10:00:00.000Z', logistic_type: 'fulfillment' },
      { id: 'order-self', ml_order_id: 222, order_date: '2026-08-01T10:00:00.000Z', logistic_type: 'self_service' },
    ]
    const supabase = {
      from(table: string) {
        if (table === 'orders') {
          return {
            select: () => ({ eq: () => ({ is: async () => ({ data: pendingOrders, error: null }) }) }),
            update: () => ({ eq: async () => ({ error: null }) }),
          }
        }
        if (table === 'order_items') {
          return {
            select: () => ({ eq: async () => ({ data: [], error: null }) }),
            update: () => ({ eq: async () => ({ error: null }) }),
          }
        }
        if (table === 'sync_runs') {
          return { insert: async () => ({ error: null }) }
        }
        throw new Error(`Unexpected table: ${table}`)
      },
    } as unknown as SupabaseClient

    const account = {
      id: 'account-1',
      userId: 'user-1',
      mlUserId: 999,
      accessToken: 'token-abc',
      refreshToken: 'refresh-abc',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }
    vi.spyOn(client, 'getValidAccessToken').mockResolvedValue('token-abc')
    const lookupInvoiceMock = vi.spyOn(omieClient, 'lookupInvoice').mockResolvedValue(null)

    await retryPendingFiscalDocuments(supabase, account)

    expect(lookupInvoiceMock).toHaveBeenNthCalledWith(1, 'filial', 111, new Date('2026-08-01T10:00:00.000Z'))
    expect(lookupInvoiceMock).toHaveBeenNthCalledWith(2, 'matriz', 222, new Date('2026-08-01T10:00:00.000Z'))
  })
```

(The `'filters pending orders by account_id and nf_fetched_at is null'` test needs no change — it only asserts the `.eq`/`.is` filter arguments, not the selected columns or the invoice lookup.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- sync.test.ts -t retryPendingFiscalDocuments`
Expected: FAIL — `retryPendingFiscalDocuments` still calls the old Mercado Livre fiscal functions and never calls `omieClient.lookupInvoice`.

- [ ] **Step 3: Implement**

In `src/lib/mercadolivre/sync.ts`, replace the pending-orders query inside `retryPendingFiscalDocuments`:

```ts
    const { data: pendingOrders, error: queryError } = await supabase
      .from('orders')
      .select('id, ml_order_id')
      .eq('account_id', account.id)
      .is('nf_fetched_at', null)
```

with:

```ts
    const { data: pendingOrders, error: queryError } = await supabase
      .from('orders')
      .select('id, ml_order_id, order_date, logistic_type')
      .eq('account_id', account.id)
      .is('nf_fetched_at', null)
```

Replace the fiscal-document fetch inside the `for` loop:

```ts
        const fiscalDocument = await findFiscalDocumentForOrder(accessToken, pendingOrder.ml_order_id)
        if (!fiscalDocument) continue // still not issued - try again on a later pass, not an error

        const xml = await downloadFiscalDocumentXml(accessToken, fiscalDocument.documentItemId)
        const invoice = parseNfeXml(xml)
        const ncmByProductCode = Object.fromEntries(invoice.items.map((item) => [item.productCode, item.ncm]))
```

with:

```ts
        const omieAccount = pendingOrder.logistic_type === 'fulfillment' ? 'filial' : 'matriz'
        const invoice = await lookupInvoice(omieAccount, pendingOrder.ml_order_id, new Date(pendingOrder.order_date))
        if (!invoice) continue // still not issued - try again on a later pass, not an error

        const ncmByProductCode = Object.fromEntries(invoice.items.map((item) => [item.productCode, item.ncm]))
```

Now that neither function in `sync.ts` uses the old Mercado Livre fiscal functions or the XML parser, remove them from the imports:

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
import { lookupInvoice } from '../omie/client'
```

becomes:

```ts
import { getValidAccessToken, searchOrders, getOrder, getShipmentAddress, getShipmentSellerCost, getBillingInfo } from './client'
import { lookupInvoice } from '../omie/client'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- sync.test.ts`
Expected: PASS, the entire file green (all `upsertOrder`, `retryPendingFiscalDocuments`, and every other `describe` block in the file).

- [ ] **Step 5: Commit**

```bash
git add src/lib/mercadolivre/sync.ts src/lib/mercadolivre/sync.test.ts
git commit -m "feat: rewire retryPendingFiscalDocuments to the Omie lookup"
```

---

### Task 7: Remove dead Mercado Livre fiscal-document code

**Files:**
- Modify: `src/lib/mercadolivre/client.ts`
- Modify: `src/lib/mercadolivre/client.test.ts`
- Delete: `src/lib/mercadolivre/nfe.ts`
- Delete: `src/lib/mercadolivre/nfe.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing (Task 5 and Task 6 already stopped calling these functions).
- Produces: nothing new — pure removal.

- [ ] **Step 1: Delete the NF-e XML parser and its test**

```bash
git rm src/lib/mercadolivre/nfe.ts src/lib/mercadolivre/nfe.test.ts
```

- [ ] **Step 2: Remove the dead functions from `client.ts`**

In `src/lib/mercadolivre/client.ts`, delete this block (the last two exports in the file):

```ts
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

- [ ] **Step 3: Remove their tests from `client.test.ts`**

In `src/lib/mercadolivre/client.test.ts`:

Replace the import list at the top:

```ts
import {
  getValidAccessToken,
  getOrder,
  searchOrders,
  getShipmentAddress,
  getShipmentSellerCost,
  getBillingInfo,
  findFiscalDocumentForOrder,
  downloadFiscalDocumentXml,
} from './client'
```

with:

```ts
import { getValidAccessToken, getOrder, searchOrders, getShipmentAddress, getShipmentSellerCost, getBillingInfo } from './client'
```

Delete the two trailing `describe` blocks (`describe('findFiscalDocumentForOrder', ...)` and `describe('downloadFiscalDocumentXml', ...)`) at the end of the file.

- [ ] **Step 4: Remove the now-unused dependency**

In `package.json`, delete the line:

```
    "fast-xml-parser": "^5.10.1",
```

Run: `npm install`
Expected: `package-lock.json` updates to drop `fast-xml-parser`; no other dependency changes.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, every test file green, no failures from missing imports.

- [ ] **Step 6: Type-check / build**

Run: `npm run build`
Expected: builds successfully — confirms no leftover reference to `findFiscalDocumentForOrder`, `downloadFiscalDocumentXml`, `parseNfeXml`, or `./nfe` anywhere in `src/`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/mercadolivre/client.ts src/lib/mercadolivre/client.test.ts package.json package-lock.json
git commit -m "chore: remove the unused Mercado Livre fiscal-documents code and fast-xml-parser"
```

---

### Task 8: `margem-contribuicao` page — thread `cnpj` through

**Files:**
- Modify: `src/app/(dashboard)/margem-contribuicao/page.tsx`

**Interfaces:**
- Consumes: Task 2's `BillingCnpj` type; Task 1/Task 5's `orders.logistic_type` column.
- Produces: correct `cnpj` passed into `calculateOrderMargin` for every row, matching the Omie-account routing rule already used at sync time.

- [ ] **Step 1: Implement**

In `src/app/(dashboard)/margem-contribuicao/page.tsx`, replace the import:

```ts
import { calculateOrderMargin, summarizeMarginPeriod } from '@/lib/margin/calculateMargin'
```

with:

```ts
import { calculateOrderMargin, summarizeMarginPeriod, type BillingCnpj } from '@/lib/margin/calculateMargin'
```

Replace the `OrderRow` interface:

```ts
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
  items: { itemValue: number; ncm: string | null; mlItemId: string; productCode: string | null; title: string; quantity: number }[]
}
```

with:

```ts
interface OrderRow {
  id: string
  orderDate: string
  mlOrderId: number
  nfNumber: string | null
  buyerName: string | null
  destinationCity: string | null
  destinationState: string | null
  cnpj: BillingCnpj
  salesChannel: string | null
  saleAmount: number
  commission: number
  shippingOrFeeAmount: number
  shippingOrFeeType: 'frete' | 'taxa_fixa'
  nfPending: boolean
  items: { itemValue: number; ncm: string | null; mlItemId: string; productCode: string | null; title: string; quantity: number }[]
}
```

Replace the Supabase `.select(...)` string:

```ts
      .select(
        'id, ml_order_id, order_date, total_amount, ml_commission, shipping_or_fee_amount, shipping_or_fee_type, destination_state, destination_city, buyer_name, sales_channel, nf_number, nf_fetched_at, order_items(ml_item_id, product_code, title, quantity, unit_price, ncm)'
      )
```

with:

```ts
      .select(
        'id, ml_order_id, order_date, total_amount, ml_commission, shipping_or_fee_amount, shipping_or_fee_type, destination_state, destination_city, logistic_type, buyer_name, sales_channel, nf_number, nf_fetched_at, order_items(ml_item_id, product_code, title, quantity, unit_price, ncm)'
      )
```

Replace the row-mapping object:

```ts
    destinationState: order.destination_state as string | null,
    salesChannel: order.sales_channel as string | null,
```

with:

```ts
    destinationState: order.destination_state as string | null,
    cnpj: (order.logistic_type as string | null) === 'fulfillment' ? 'filial' : 'matriz',
    salesChannel: order.sales_channel as string | null,
```

Replace the `calculateOrderMargin` call:

```ts
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
```

with:

```ts
    const margin = calculateOrderMargin({
      saleAmount: row.saleAmount,
      productCost: anyCostMissing ? null : productCost,
      commission: row.commission,
      shippingOrFeeAmount: row.shippingOrFeeAmount,
      shippingOrFeeType: row.shippingOrFeeType,
      items: row.items.map((item) => ({ itemValue: item.itemValue, ncm: item.ncm })),
      destinationState: row.destinationState,
      nfPending: row.nfPending,
      cnpj: row.cnpj,
    })
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: builds successfully with no type errors (this page has no existing test file — `next build`'s type-checking is the only automated check for this task).

- [ ] **Step 3: Commit**

```bash
git add "src/app/(dashboard)/margem-contribuicao/page.tsx"
git commit -m "feat: pass the correct CNPJ into the margin calculation on the Margem de contribuição page"
```

---

### Task 9: Rollout, live verification, and manual smoke test

**Files:** none (operational task).

- [ ] **Step 1: Get the Omie credentials from the owner**

Ask the owner for both Omie accounts' App Key/App Secret (matriz CNPJ `16.864.672/0001-85` and filial CNPJ `16.864.672/0003-47`). Set the four variables in `.env.local` locally, then later in the production environment (EasyPanel), following the same pattern as `SUPABASE_SERVICE_ROLE_KEY`.

- [ ] **Step 2: Confirm the real Omie response shape**

Make one real `ConsultarNF` call (either account) against a known real invoice — e.g. via a throwaway script calling `lookupInvoice` directly, or `curl` against the endpoint with the request shape from Task 3. Compare the real response's field names/nesting against `OmieNfCadastro` in `src/lib/omie/client.ts`. If they differ, update that interface and `toInvoice`/`invoiceMentionsOrder` to match, and re-run `npm test -- src/lib/omie` with adjusted test fixtures.

- [ ] **Step 3: Confirm whether `cCodNFInt` carries the Mercado Livre order number**

From the same real call (or a second one), check whether the invoice's `cCodNFInt` was actually populated with the Mercado Livre order number. This determines whether the `ListarNF` fallback is the common path or a rare one in production — worth knowing before relying on the "aguardando XML" state to mean "not yet issued" rather than "our lookup missed it."

- [ ] **Step 4: Flag the verification risk to the human**

Report explicitly whether Step 2 and Step 3 confirmed the assumptions in Task 3's code, or required changes. This mirrors the exact situation that produced this spec in the first place (the Mercado Livre Fiscal Documents API turned out not to work as documented) — don't let it go unverified silently a second time.

- [ ] **Step 5: Manual smoke test**

With real credentials and a synced Mercado Livre account:
1. Trigger a resync (the existing "Ressincronizar" button, or wait for the next reconciliation cycle) for an order that previously showed "aguardando XML".
2. Confirm it now shows a real NF number, and that `order_items.ncm` is populated for its items.
3. If the account has at least one Mercado Envios Full order, confirm its `orders.logistic_type` is `'fulfillment'` and that its ICMS debit on the Margem de contribuição page matches the filial table (18% SP / 12% PR,RS,SC,RJ,MG / 7% elsewhere) rather than the matriz table.
4. If an order stays on "aguardando XML" across several reconciliation cycles (15+ minutes apart), check that account's `sync_runs.last_error` — it should say whether Omie genuinely has no invoice yet or whether the lookup itself is failing (e.g. wrong credentials, wrong account).

This closes the "P" (Plano) stage. Per the project's standing workflow, the next stage is "A" (Auditoria): run `/code-review` and a security review over this branch before merging/deploying — pay particular attention to the Omie credential handling (server-only, never exposed to the browser) and to the matriz/filial routing logic, since a misroute would silently apply the wrong company's ICMS rules to a real sale.
