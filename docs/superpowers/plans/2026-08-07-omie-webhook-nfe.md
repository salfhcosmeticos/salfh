# Integração com a Omie via webhook para NCM e XML da nota — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the polling-based Omie invoice lookup (which live testing found built on a wrong assumption — see the spec) with a webhook-driven design: Omie pushes an `NFe.NotaAutorizada` event the moment an invoice is authorized, this project resolves it to the right Mercado Livre order with one direct call, stores the NCM per item and links to the XML/DANFE, and a one-time backfill pass covers orders invoiced before the webhook existed.

**Architecture:** Two new, additive Omie webhooks (one per account — matriz and filial are separate Omie apps) hit a new route (`src/app/api/webhooks/omie/route.ts`), which resolves the Mercado Livre order via a single `ConsultarPedido` call, fetches and parses the invoice XML (a direct CDN link from the webhook payload), and writes `orders`/`order_items`. A small `pending_omie_invoices` table catches events that arrive before the order is synced from Mercado Livre, cleared by a cheap periodic sweep (no Omie calls). A one-time, admin-triggered backfill route covers pre-existing pending orders using the two-stage `ListarPedidos` → `ListarNF` → `ObterNfe` chain mapped out live against production this session.

**Tech Stack:** Next.js 15 (App Router) + TypeScript, Supabase (Postgres + `@supabase/supabase-js`), Vitest, `fast-xml-parser` (re-added — removed in the superseded plan, needed again here), plain `fetch` for Omie HTTP calls.

## Global Constraints

- **Mercado Livre and Omie only, read-only.** Every new Omie call in this plan is a read (`ConsultarPedido`, `ListarPedidos`, `ListarNF`, `ObterNfe`) or a passive webhook receiver. Nothing writes to Omie or Mercado Livre.
- **Do not touch the existing "Weesutech" webhook** in either Omie account (matriz app, and filial app if one exists there too) — it is live third-party production infrastructure this project does not own. Every webhook this plan adds is a *second*, independent registration, never an edit to what's already there.
- **Store only links to the XML/DANFE, never the file itself** (`orders.nfe_xml_url`, `orders.nfe_danfe_url`) — confirmed decision with the owner: Omie's own CDN link is the system of record; this project never downloads-and-keeps a copy.
- **`orders.logistic_type` keeps its existing role** (captured at Mercado Livre sync time, drives the margin page's matriz/filial rate-table choice) — this plan does not touch that. It's also reused as a starting guess for which Omie account to search first during backfill, but is never authoritative for that (the account a Pedido is actually found in always wins).
- **Ships to `main` directly, not pushed to `origin` until the owner asks** — this repo's established convention.
- **One unconfirmed field, flagged honestly, not guessed away:** whether `ConsultarPedido`'s response includes `informacoes_adicionais.numero_pedido_cliente` the same way `ListarPedidos`'s per-item response does. Both return the same `pedido_venda_produto` object family and this session confirmed `ListarPedidos` has it; `ConsultarPedido` was only inspected up to `cabecalho`/`det` (its `det[].imposto` block is huge) before running out of budget to keep testing. Task 3 flags this in code and Task 9's rollout re-confirms it with one real call before the webhook path is trusted in production.

---

## File Structure

| File | Change |
|---|---|
| `supabase/migrations/0006_omie_nfe_webhook.sql` | Create — `orders.nfe_xml_url`/`nfe_danfe_url`, new `pending_omie_invoices` table |
| `src/lib/omie/nfe.ts` | Create — `parseOmieNfeXml` (NCM normalization added) |
| `src/lib/omie/nfe.test.ts` | Create |
| `src/lib/omie/client.ts` | Rewrite — drop `lookupInvoice`, add `consultarPedido`, `listarPedidos`, `listarNF`, `obterNfe`, `formatOmieDate` |
| `src/lib/omie/client.test.ts` | Rewrite |
| `src/lib/omie/webhook.ts` | Create — `handleOmieWebhook`, `applyInvoiceToOrder` |
| `src/lib/omie/webhook.test.ts` | Create |
| `src/app/api/webhooks/omie/route.ts` | Create |
| `src/app/api/webhooks/omie/route.test.ts` | Create |
| `src/lib/omie/pendingInvoices.ts` | Create — `applyPendingOmieInvoices` |
| `src/lib/omie/pendingInvoices.test.ts` | Create |
| `src/lib/mercadolivre/sync.ts` | Modify — `upsertOrder` stops touching Omie; `retryPendingFiscalDocuments` deleted |
| `src/lib/mercadolivre/sync.test.ts` | Modify — matching test changes |
| `src/lib/mercadolivre/cron.ts` | Modify — swap `retryPendingFiscalDocuments` for `applyPendingOmieInvoices` |
| `src/app/api/omie/backfill/route.ts` | Create — one-time backfill |
| `src/app/api/omie/backfill/route.test.ts` | Create |
| `src/app/(dashboard)/margem-contribuicao/page.tsx` | Modify — link the NF cell to the DANFE, rename stale "aguardando XML" label |
| `package.json` | Modify — re-add `fast-xml-parser` |
| `.env.example` | Modify — add `OMIE_WEBHOOK_SECRET` |

---

### Task 1: Database migration — `nfe_xml_url`, `nfe_danfe_url`, `pending_omie_invoices`

**Files:**
- Create: `supabase/migrations/0006_omie_nfe_webhook.sql`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `orders.nfe_xml_url text`, `orders.nfe_danfe_url text` (both nullable) — consumed by Task 6 (write), Task 8 (read). `public.pending_omie_invoices` table — consumed by Task 4 (write) and Task 5 (read/delete).

- [ ] **Step 1: Write the migration**

`supabase/migrations/0006_omie_nfe_webhook.sql`:

```sql
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
```

- [ ] **Step 2: Apply the migration**

Use the Supabase MCP tools if available (`mcp__plugin_supabase_supabase__apply_migration` with project_id `lrscmdpaprfsprgceymz`, name `omie_nfe_webhook`, and this file's SQL as `query`); otherwise apply it via the Supabase Dashboard's SQL Editor.

- [ ] **Step 3: Verify**

```sql
select table_name, column_name from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'orders' and column_name in ('nfe_xml_url', 'nfe_danfe_url'))
    or (table_name = 'pending_omie_invoices'));
```

Expected: `orders.nfe_xml_url`, `orders.nfe_danfe_url`, and all six `pending_omie_invoices` columns listed.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0006_omie_nfe_webhook.sql
git commit -m "feat: add nfe_xml_url/nfe_danfe_url and pending_omie_invoices table"
```

---

### Task 2: Omie NFe XML parser

**Files:**
- Create: `src/lib/omie/nfe.ts`
- Create: `src/lib/omie/nfe.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing (pure function, no I/O).
- Produces: `export interface OmieNfeXmlItem { productCode: string; ncm: string }`; `export interface OmieNfeXmlData { invoiceNumber: string; items: OmieNfeXmlItem[] }`; `export function parseOmieNfeXml(xml: string): OmieNfeXmlData` — consumed by Task 4 (webhook path) and Task 7 (backfill path).

- [ ] **Step 1: Re-add the XML parser dependency**

In `package.json`, add this line to `dependencies` (alphabetically, between `"date-fns"` and `"lucide-react"`):

```json
    "fast-xml-parser": "^5.10.1",
```

Run: `npm install`

- [ ] **Step 2: Write the failing tests**

Create `src/lib/omie/nfe.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseOmieNfeXml } from './nfe'

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

describe('parseOmieNfeXml', () => {
  it('parses the invoice number and the single product line of a one-item invoice', () => {
    const result = parseOmieNfeXml(SINGLE_ITEM_NFE)
    expect(result.invoiceNumber).toBe('123456')
    expect(result.items).toEqual([{ productCode: 'SF9004', ncm: '33059000' }])
  })

  it('parses every product line of a multi-item invoice', () => {
    const result = parseOmieNfeXml(MULTI_ITEM_NFE)
    expect(result.invoiceNumber).toBe('654321')
    expect(result.items).toEqual([
      { productCode: 'SF9004', ncm: '33059000' },
      { productCode: 'SF9846', ncm: '33051000' },
    ])
  })

  it('throws a clear error when the XML has no infNFe block', () => {
    expect(() => parseOmieNfeXml('<not-an-nfe/>')).toThrow(/infNFe/)
  })

  it('preserves leading zeros in the product code instead of letting the XML parser coerce it to a number', () => {
    const xml = `<?xml version="1.0"?>
<nfeProc><NFe><infNFe>
  <ide><nNF>123456</nNF></ide>
  <det nItem="1"><prod><cProd>007</cProd><NCM>03051000</NCM></prod></det>
</infNFe></NFe></nfeProc>`

    const result = parseOmieNfeXml(xml)

    expect(result.items).toEqual([{ productCode: '007', ncm: '03051000' }])
  })

  it('strips formatting punctuation from NCM (Omie\'s structured API returns it dotted, e.g. "3305.90.00" - the raw XML may too)', () => {
    const xml = `<?xml version="1.0"?>
<nfeProc><NFe><infNFe>
  <ide><nNF>123456</nNF></ide>
  <det nItem="1"><prod><cProd>BB00078</cProd><NCM>3305.90.00</NCM></prod></det>
</infNFe></NFe></nfeProc>`

    const result = parseOmieNfeXml(xml)

    expect(result.items).toEqual([{ productCode: 'BB00078', ncm: '33059000' }])
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/lib/omie/nfe`
Expected: FAIL — `./nfe` does not exist yet.

- [ ] **Step 4: Implement**

Create `src/lib/omie/nfe.ts`:

```ts
import { XMLParser } from 'fast-xml-parser'

export interface OmieNfeXmlItem {
  productCode: string
  ncm: string
}

export interface OmieNfeXmlData {
  invoiceNumber: string
  items: OmieNfeXmlItem[]
}

const parser = new XMLParser({ parseTagValue: false, processEntities: false })

function normalizeNcm(raw: string): string {
  return raw.replace(/\D/g, '')
}

export function parseOmieNfeXml(xml: string): OmieNfeXmlData {
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
      ncm: normalizeNcm(String(det.prod.NCM)),
    })),
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/lib/omie/nfe`
Expected: PASS, all 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/omie/nfe.ts src/lib/omie/nfe.test.ts
git commit -m "feat: add Omie NFe XML parser with NCM normalization"
```

---

### Task 3: Rewrite the Omie client — `consultarPedido`, `listarPedidos`, `listarNF`, `obterNfe`

**Files:**
- Modify (full rewrite): `src/lib/omie/client.ts`
- Modify (full rewrite): `src/lib/omie/client.test.ts`

**Interfaces:**
- Consumes: `OMIE_MATRIZ_APP_KEY`/`SECRET`, `OMIE_FILIAL_APP_KEY`/`SECRET` (unchanged from before).
- Produces:
  - `export type OmieAccount = 'matriz' | 'filial'` (unchanged)
  - `export async function consultarPedido(account: OmieAccount, codigoPedido: number): Promise<{ numeroPedidoCliente: string | null }>` — consumed by Task 4 (webhook path).
  - `export interface OmiePedidoListItem { codigoPedido: number; numeroPedidoCliente: string | null }`; `export interface OmiePedidoPage { pedidos: OmiePedidoListItem[]; totalPaginas: number }`; `export async function listarPedidos(account: OmieAccount, pagina: number, dataInicial: string, dataFinal: string): Promise<OmiePedidoPage>` — consumed by Task 7 (backfill).
  - `export interface OmieNfListItem { nIdNf: number; nIdPedido: number }`; `export interface OmieNfPage { notas: OmieNfListItem[]; totalPaginas: number }`; `export async function listarNF(account: OmieAccount, pagina: number, dEmiInicial: string, dEmiFinal: string): Promise<OmieNfPage>` — consumed by Task 7.
  - `export interface OmieNfeDocument { invoiceNumber: string; chaveNfe: string; xml: string; pdfUrl: string }`; `export async function obterNfe(account: OmieAccount, nIdNfe: number): Promise<OmieNfeDocument>` — consumed by Task 7. `xml` is already HTML-entity-decoded (raw, parseable XML text) by the time it's returned.
  - `export function formatOmieDate(date: Date): string` (DD/MM/YYYY) — consumed by Task 7.

This task **deletes** `lookupInvoice`, `OmieInvoice`, `OmieInvoiceItem` entirely — nothing in the codebase will import them after Task 6.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `src/lib/omie/client.test.ts` with:

```ts
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { consultarPedido, listarPedidos, listarNF, obterNfe, formatOmieDate } from './client'

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

describe('formatOmieDate', () => {
  it('formats as DD/MM/YYYY using UTC fields', () => {
    expect(formatOmieDate(new Date('2026-08-07T00:00:00.000Z'))).toBe('07/08/2026')
    expect(formatOmieDate(new Date('2026-01-05T23:00:00.000Z'))).toBe('05/01/2026')
  })
})

describe('consultarPedido', () => {
  it('returns numeroPedidoCliente from a real-shaped response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pedido_venda_produto: {
          cabecalho: { codigo_pedido: 11248244211 },
          informacoes_adicionais: { numero_pedido_cliente: '2000017307031470' },
        },
      }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await consultarPedido('matriz', 11248244211)

    expect(result).toEqual({ numeroPedidoCliente: '2000017307031470' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://app.omie.com.br/api/v1/produtos/pedido/',
      expect.objectContaining({ method: 'POST' })
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({
      call: 'ConsultarPedido',
      app_key: 'matriz-key',
      app_secret: 'matriz-secret',
      param: [{ codigo_pedido: 11248244211 }],
    })
  })

  it('returns numeroPedidoCliente: null when informacoes_adicionais is absent', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pedido_venda_produto: { cabecalho: { codigo_pedido: 1 } } }),
    }) as unknown as typeof fetch

    expect(await consultarPedido('matriz', 1)).toEqual({ numeroPedidoCliente: null })
  })

  it('uses the filial credentials when called with "filial"', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pedido_venda_produto: { cabecalho: { codigo_pedido: 1 } } }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    await consultarPedido('filial', 1)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({ app_key: 'filial-key', app_secret: 'filial-secret' })
  })

  it('throws on an HTTP error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch

    await expect(consultarPedido('matriz', 1)).rejects.toThrow('Omie API error on ConsultarPedido: 500')
  })
})

describe('listarPedidos', () => {
  it('maps pedido_venda_produto entries and total_de_paginas', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total_de_paginas: 32,
        pedido_venda_produto: [
          { cabecalho: { codigo_pedido: 11248244211 }, informacoes_adicionais: { numero_pedido_cliente: '2000017307031470' } },
          { cabecalho: { codigo_pedido: 999 } },
        ],
      }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const page = await listarPedidos('matriz', 1, '05/07/2026', '10/07/2026')

    expect(page).toEqual({
      totalPaginas: 32,
      pedidos: [
        { codigoPedido: 11248244211, numeroPedidoCliente: '2000017307031470' },
        { codigoPedido: 999, numeroPedidoCliente: null },
      ],
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({
      call: 'ListarPedidos',
      param: [{ pagina: 1, registros_por_pagina: 100, filtrar_por_data_de: '05/07/2026', filtrar_por_data_ate: '10/07/2026' }],
    })
  })

  it('throws on an HTTP error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch

    await expect(listarPedidos('matriz', 1, '05/07/2026', '10/07/2026')).rejects.toThrow(
      'Omie API error on ListarPedidos: 500'
    )
  })
})

describe('listarNF', () => {
  it('maps nfCadastro entries and total_de_paginas', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total_de_paginas: 7,
        nfCadastro: [{ compl: { nIdNF: 11248244216, nIdPedido: 11248244211 } }],
      }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const page = await listarNF('matriz', 1, '07/07/2026', '07/07/2026')

    expect(page).toEqual({ totalPaginas: 7, notas: [{ nIdNf: 11248244216, nIdPedido: 11248244211 }] })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({
      call: 'ListarNF',
      param: [{ pagina: 1, registros_por_pagina: 100, dEmiInicial: '07/07/2026', dEmiFinal: '07/07/2026' }],
    })
  })

  it('returns an empty list when nfCadastro is absent', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ total_de_paginas: 1 }),
    }) as unknown as typeof fetch

    expect(await listarNF('matriz', 1, '07/07/2026', '07/07/2026')).toEqual({ totalPaginas: 1, notas: [] })
  })

  it('throws on an HTTP error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch

    await expect(listarNF('matriz', 1, '07/07/2026', '07/07/2026')).rejects.toThrow('Omie API error on ListarNF: 500')
  })
})

describe('obterNfe', () => {
  it('returns the invoice fields and decodes the HTML-entity-encoded XML', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        cNumNfe: '00031513',
        nChaveNfe: '41260716864672000185550070000315131785292297',
        cXmlNfe: '&lt;?xml version=&quot;1.0&quot;?&gt;&lt;nfeProc&gt;&lt;/nfeProc&gt;',
        cPdf: 'https://click.omie.com/pdfnfe-2vspv6x5gup5',
        cCodStatus: '0',
        cDesStatus: 'Documentos gerados com sucesso!',
      }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const nfe = await obterNfe('matriz', 11248244216)

    expect(nfe).toEqual({
      invoiceNumber: '00031513',
      chaveNfe: '41260716864672000185550070000315131785292297',
      xml: '<?xml version="1.0"?><nfeProc></nfeProc>',
      pdfUrl: 'https://click.omie.com/pdfnfe-2vspv6x5gup5',
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({
      call: 'ObterNfe',
      param: [{ nIdNfe: 11248244216 }],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://app.omie.com.br/api/v1/produtos/dfedocs/',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('throws on an HTTP error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch

    await expect(obterNfe('matriz', 1)).rejects.toThrow('Omie API error on ObterNfe: 500')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/omie/client`
Expected: FAIL — none of these functions exist yet (the file still has `lookupInvoice`).

- [ ] **Step 3: Implement**

Replace the full contents of `src/lib/omie/client.ts` with:

```ts
import 'server-only'

export type OmieAccount = 'matriz' | 'filial'

function getCredentials(account: OmieAccount): { appKey: string; appSecret: string } {
  return account === 'filial'
    ? { appKey: process.env.OMIE_FILIAL_APP_KEY!, appSecret: process.env.OMIE_FILIAL_APP_SECRET! }
    : { appKey: process.env.OMIE_MATRIZ_APP_KEY!, appSecret: process.env.OMIE_MATRIZ_APP_SECRET! }
}

const OMIE_PEDIDO_ENDPOINT = 'https://app.omie.com.br/api/v1/produtos/pedido/'
const OMIE_NF_ENDPOINT = 'https://app.omie.com.br/api/v1/produtos/nfconsultar/'
const OMIE_DFE_ENDPOINT = 'https://app.omie.com.br/api/v1/produtos/dfedocs/'
const RECORDS_PER_PAGE = 100

async function omiePost<T>(endpoint: string, call: string, account: OmieAccount, param: Record<string, unknown>): Promise<T> {
  const { appKey, appSecret } = getCredentials(account)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ call, app_key: appKey, app_secret: appSecret, param: [param] }),
  })
  if (!response.ok) {
    throw new Error(`Omie API error on ${call}: ${response.status}`)
  }
  return response.json()
}

export function formatOmieDate(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const yyyy = date.getUTCFullYear()
  return `${dd}/${mm}/${yyyy}`
}

// --- Pedido de Venda ---
//
// Exact nesting confirmed against a real ListarPedidos entry this session
// (informacoes_adicionais.numero_pedido_cliente holds the Mercado Livre
// order number). ConsultarPedido returns the same pedido_venda_produto
// object family but was only spot-checked up to cabecalho/det - verify
// informacoes_adicionais is present the same way with one real call before
// trusting this in production (Task 9's rollout does this).
interface OmiePedidoCabecalho {
  codigo_pedido: number
}

interface OmiePedidoInformacoesAdicionais {
  numero_pedido_cliente?: string
}

interface OmiePedidoVendaProduto {
  cabecalho: OmiePedidoCabecalho
  informacoes_adicionais?: OmiePedidoInformacoesAdicionais
}

interface OmieConsultarPedidoResponse {
  pedido_venda_produto: OmiePedidoVendaProduto
}

export async function consultarPedido(
  account: OmieAccount,
  codigoPedido: number
): Promise<{ numeroPedidoCliente: string | null }> {
  const response = await omiePost<OmieConsultarPedidoResponse>(OMIE_PEDIDO_ENDPOINT, 'ConsultarPedido', account, {
    codigo_pedido: codigoPedido,
  })
  return { numeroPedidoCliente: response.pedido_venda_produto.informacoes_adicionais?.numero_pedido_cliente ?? null }
}

export interface OmiePedidoListItem {
  codigoPedido: number
  numeroPedidoCliente: string | null
}

export interface OmiePedidoPage {
  pedidos: OmiePedidoListItem[]
  totalPaginas: number
}

interface OmieListarPedidosResponse {
  total_de_paginas: number
  pedido_venda_produto?: OmiePedidoVendaProduto[]
}

export async function listarPedidos(
  account: OmieAccount,
  pagina: number,
  dataInicial: string,
  dataFinal: string
): Promise<OmiePedidoPage> {
  const response = await omiePost<OmieListarPedidosResponse>(OMIE_PEDIDO_ENDPOINT, 'ListarPedidos', account, {
    pagina,
    registros_por_pagina: RECORDS_PER_PAGE,
    filtrar_por_data_de: dataInicial,
    filtrar_por_data_ate: dataFinal,
  })
  return {
    totalPaginas: response.total_de_paginas,
    pedidos: (response.pedido_venda_produto ?? []).map((p) => ({
      codigoPedido: p.cabecalho.codigo_pedido,
      numeroPedidoCliente: p.informacoes_adicionais?.numero_pedido_cliente ?? null,
    })),
  }
}

// --- Nota Fiscal (nfconsultar) ---

export interface OmieNfListItem {
  nIdNf: number
  nIdPedido: number
}

export interface OmieNfPage {
  notas: OmieNfListItem[]
  totalPaginas: number
}

interface OmieNfComplSummary {
  nIdNF: number
  nIdPedido: number
}

interface OmieListarNfResponse {
  total_de_paginas: number
  nfCadastro?: { compl: OmieNfComplSummary }[]
}

export async function listarNF(
  account: OmieAccount,
  pagina: number,
  dEmiInicial: string,
  dEmiFinal: string
): Promise<OmieNfPage> {
  const response = await omiePost<OmieListarNfResponse>(OMIE_NF_ENDPOINT, 'ListarNF', account, {
    pagina,
    registros_por_pagina: RECORDS_PER_PAGE,
    dEmiInicial,
    dEmiFinal,
  })
  return {
    totalPaginas: response.total_de_paginas,
    notas: (response.nfCadastro ?? []).map((nf) => ({ nIdNf: nf.compl.nIdNF, nIdPedido: nf.compl.nIdPedido })),
  }
}

// --- Documento Fiscal Eletrônico (dfedocs) ---

export interface OmieNfeDocument {
  invoiceNumber: string
  chaveNfe: string
  xml: string
  pdfUrl: string
}

interface OmieObterNfeResponse {
  cNumNfe: string
  nChaveNfe: string
  cXmlNfe: string
  cPdf: string
}

function decodeXmlEntities(encoded: string): string {
  return encoded.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

export async function obterNfe(account: OmieAccount, nIdNfe: number): Promise<OmieNfeDocument> {
  const response = await omiePost<OmieObterNfeResponse>(OMIE_DFE_ENDPOINT, 'ObterNfe', account, { nIdNfe })
  return {
    invoiceNumber: response.cNumNfe,
    chaveNfe: response.nChaveNfe,
    xml: decodeXmlEntities(response.cXmlNfe),
    pdfUrl: response.cPdf,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/omie/client`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/omie/client.ts src/lib/omie/client.test.ts
git commit -m "feat: rewrite Omie client for the webhook-driven design (consultarPedido/listarPedidos/listarNF/obterNfe)"
```

---

### Task 4: Omie webhook handler + route

**Files:**
- Create: `src/lib/omie/webhook.ts`
- Create: `src/lib/omie/webhook.test.ts`
- Create: `src/app/api/webhooks/omie/route.ts`
- Create: `src/app/api/webhooks/omie/route.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: Task 2's `parseOmieNfeXml`; Task 3's `consultarPedido`; Task 1's `pending_omie_invoices` table.
- Produces: `export async function applyInvoiceToOrder(supabase: SupabaseClient, orderId: string, invoice: { nfNumber: string; nfeXmlUrl: string | null; nfeDanfeUrl: string | null; ncmByProductCode: Record<string, string> }): Promise<void>` — consumed by Task 5 and Task 7. `export async function handleOmieWebhook(supabase: SupabaseClient, account: OmieAccount, payload: unknown): Promise<void>` — consumed by the route in this task.

- [ ] **Step 1: Write the failing tests for the webhook handler**

Create `src/lib/omie/webhook.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { handleOmieWebhook, applyInvoiceToOrder } from './webhook'
import * as client from './client'

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

const VALID_PAYLOAD = {
  topic: 'NFe.NotaAutorizada',
  event: {
    id_pedido: 11268650737,
    id_nf: 11268650821,
    empresa_cnpj: '16864672000185',
    numero_nf: '00037493',
    nfe_xml: 'https://cdn.omie.com.br/repository/xml',
    nfe_danfe: 'https://cdn.omie.com.br/repository/pdf',
  },
}

const SAMPLE_XML =
  '<?xml version="1.0"?><nfeProc><NFe><infNFe><ide><nNF>37493</nNF></ide>' +
  '<det nItem="1"><prod><cProd>SF9004</cProd><NCM>33059000</NCM></prod></det></infNFe></NFe></nfeProc>'

function createFakeSupabase() {
  const orderUpdateCalls: unknown[] = []
  const itemUpdateCalls: unknown[] = []
  const pendingUpsertCalls: unknown[] = []
  let orderRow: { id: string } | null = { id: 'order-row-1' }
  let items: { id: string; product_code: string | null }[] = [{ id: 'item-1', product_code: 'SF9004' }]

  const supabaseClient = {
    from(table: string) {
      if (table === 'orders') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: orderRow, error: null }) }) }),
          update: (data: unknown) => ({
            eq: async (_col: string, id: string) => {
              orderUpdateCalls.push({ data, id })
              return { error: null }
            },
          }),
        }
      }
      if (table === 'order_items') {
        return {
          select: () => ({ eq: async () => ({ data: items, error: null }) }),
          update: (data: unknown) => ({
            eq: async (_col: string, id: string) => {
              itemUpdateCalls.push({ data, id })
              return { error: null }
            },
          }),
        }
      }
      if (table === 'pending_omie_invoices') {
        return {
          upsert: async (data: unknown, opts: unknown) => {
            pendingUpsertCalls.push({ data, opts })
            return { error: null }
          },
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
  }

  return {
    client: supabaseClient as unknown as SupabaseClient,
    orderUpdateCalls,
    itemUpdateCalls,
    pendingUpsertCalls,
    setOrderRow: (row: { id: string } | null) => {
      orderRow = row
    },
    setItems: (rows: { id: string; product_code: string | null }[]) => {
      items = rows
    },
  }
}

describe('handleOmieWebhook', () => {
  it('resolves the order via consultarPedido, downloads and parses the XML, and writes orders/order_items', async () => {
    vi.spyOn(client, 'consultarPedido').mockResolvedValue({ numeroPedidoCliente: '2000017307031470' })
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE_XML }) as unknown as typeof fetch
    const { client: supabase, orderUpdateCalls, itemUpdateCalls } = createFakeSupabase()

    await handleOmieWebhook(supabase, 'matriz', VALID_PAYLOAD)

    expect(client.consultarPedido).toHaveBeenCalledWith('matriz', 11268650737)
    expect(orderUpdateCalls[0]).toMatchObject({
      id: 'order-row-1',
      data: expect.objectContaining({
        nf_number: '00037493',
        nfe_xml_url: 'https://cdn.omie.com.br/repository/xml',
        nfe_danfe_url: 'https://cdn.omie.com.br/repository/pdf',
      }),
    })
    expect(itemUpdateCalls[0]).toMatchObject({ id: 'item-1', data: { ncm: '33059000' } })
  })

  it('ignores a payload for a different topic', async () => {
    const consultarPedidoMock = vi.spyOn(client, 'consultarPedido')
    const { client: supabase } = createFakeSupabase()

    await handleOmieWebhook(supabase, 'matriz', { topic: 'produto.alterado', event: {} })

    expect(consultarPedidoMock).not.toHaveBeenCalled()
  })

  it('ignores a malformed payload without throwing', async () => {
    const { client: supabase } = createFakeSupabase()

    await expect(handleOmieWebhook(supabase, 'matriz', { not: 'valid' })).resolves.toBeUndefined()
    await expect(handleOmieWebhook(supabase, 'matriz', null)).resolves.toBeUndefined()
  })

  it('parks the event in pending_omie_invoices when the order has not been synced from Mercado Livre yet', async () => {
    vi.spyOn(client, 'consultarPedido').mockResolvedValue({ numeroPedidoCliente: '2000017307031470' })
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE_XML }) as unknown as typeof fetch
    const { client: supabase, setOrderRow, pendingUpsertCalls, orderUpdateCalls } = createFakeSupabase()
    setOrderRow(null)

    await handleOmieWebhook(supabase, 'matriz', VALID_PAYLOAD)

    expect(orderUpdateCalls).toHaveLength(0)
    expect(pendingUpsertCalls[0]).toMatchObject({
      opts: { onConflict: 'ml_order_id' },
      data: expect.objectContaining({
        ml_order_id: 2000017307031470,
        nf_number: '00037493',
        ncm_by_product_code: { SF9004: '33059000' },
      }),
    })
  })

  it('does nothing when the Pedido has no numeroPedidoCliente to link to', async () => {
    vi.spyOn(client, 'consultarPedido').mockResolvedValue({ numeroPedidoCliente: null })
    const { client: supabase, orderUpdateCalls, pendingUpsertCalls } = createFakeSupabase()

    await handleOmieWebhook(supabase, 'matriz', VALID_PAYLOAD)

    expect(orderUpdateCalls).toHaveLength(0)
    expect(pendingUpsertCalls).toHaveLength(0)
  })

  it('throws when the XML download fails, so the caller can log it', async () => {
    vi.spyOn(client, 'consultarPedido').mockResolvedValue({ numeroPedidoCliente: '2000017307031470' })
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch
    const { client: supabase } = createFakeSupabase()

    await expect(handleOmieWebhook(supabase, 'matriz', VALID_PAYLOAD)).rejects.toThrow('Failed to download NFe XML: 500')
  })
})

describe('applyInvoiceToOrder', () => {
  it('leaves an item untouched when its product_code has no NCM in the map', async () => {
    const { client: supabase, setItems, itemUpdateCalls } = createFakeSupabase()
    setItems([{ id: 'item-1', product_code: 'UNKNOWN' }])

    await applyInvoiceToOrder(supabase, 'order-row-1', {
      nfNumber: '123',
      nfeXmlUrl: null,
      nfeDanfeUrl: null,
      ncmByProductCode: { SF9004: '33059000' },
    })

    expect(itemUpdateCalls).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/omie/webhook`
Expected: FAIL — `./webhook` does not exist yet.

- [ ] **Step 3: Implement the webhook handler**

Create `src/lib/omie/webhook.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { consultarPedido, type OmieAccount } from './client'
import { parseOmieNfeXml } from './nfe'

interface OmieNfeAutorizadaEvent {
  id_pedido: number
  id_nf: number
  numero_nf: string
  nfe_xml: string
  nfe_danfe: string
}

interface OmieNfeAutorizadaPayload {
  topic: 'NFe.NotaAutorizada'
  event: OmieNfeAutorizadaEvent
}

function isNfeAutorizadaPayload(payload: unknown): payload is OmieNfeAutorizadaPayload {
  if (!payload || typeof payload !== 'object') return false
  const candidate = payload as Record<string, unknown>
  if (candidate.topic !== 'NFe.NotaAutorizada') return false
  const event = candidate.event
  if (!event || typeof event !== 'object') return false
  const e = event as Record<string, unknown>
  return (
    typeof e.id_pedido === 'number' &&
    typeof e.id_nf === 'number' &&
    typeof e.numero_nf === 'string' &&
    typeof e.nfe_xml === 'string' &&
    typeof e.nfe_danfe === 'string'
  )
}

export interface InvoiceToApply {
  nfNumber: string
  nfeXmlUrl: string | null
  nfeDanfeUrl: string | null
  ncmByProductCode: Record<string, string>
}

export async function applyInvoiceToOrder(
  supabase: SupabaseClient,
  orderId: string,
  invoice: InvoiceToApply
): Promise<void> {
  await supabase
    .from('orders')
    .update({
      nf_number: invoice.nfNumber,
      nf_fetched_at: new Date().toISOString(),
      nfe_xml_url: invoice.nfeXmlUrl,
      nfe_danfe_url: invoice.nfeDanfeUrl,
    })
    .eq('id', orderId)

  const { data: items } = await supabase.from('order_items').select('id, product_code').eq('order_id', orderId)

  for (const item of items ?? []) {
    const ncm = item.product_code ? invoice.ncmByProductCode[item.product_code] : undefined
    if (ncm) {
      await supabase.from('order_items').update({ ncm }).eq('id', item.id)
    }
  }
}

export async function handleOmieWebhook(supabase: SupabaseClient, account: OmieAccount, payload: unknown): Promise<void> {
  if (!isNfeAutorizadaPayload(payload)) {
    return // Not a topic we act on (e.g. produto.alterado), or malformed - ignore, don't error.
  }

  const { event } = payload

  const { numeroPedidoCliente } = await consultarPedido(account, event.id_pedido)
  if (!numeroPedidoCliente) {
    // No Mercado Livre order number recorded on this Pedido - nothing to
    // link the invoice to. Not this handler's job to guess further.
    return
  }

  const mlOrderId = Number(numeroPedidoCliente)
  if (!Number.isFinite(mlOrderId)) {
    return
  }

  const xmlResponse = await fetch(event.nfe_xml)
  if (!xmlResponse.ok) {
    throw new Error(`Failed to download NFe XML: ${xmlResponse.status}`)
  }
  const invoice = parseOmieNfeXml(await xmlResponse.text())
  const ncmByProductCode = Object.fromEntries(invoice.items.map((item) => [item.productCode, item.ncm]))

  const { data: orderRow } = await supabase.from('orders').select('id').eq('ml_order_id', mlOrderId).maybeSingle()

  if (!orderRow) {
    // Order not synced from Mercado Livre yet - park it for
    // applyPendingOmieInvoices (Task 5) to pick up once it arrives, rather
    // than dropping a real invoice notification.
    await supabase.from('pending_omie_invoices').upsert(
      {
        ml_order_id: mlOrderId,
        nf_number: event.numero_nf,
        nfe_xml_url: event.nfe_xml,
        nfe_danfe_url: event.nfe_danfe,
        ncm_by_product_code: ncmByProductCode,
      },
      { onConflict: 'ml_order_id' }
    )
    return
  }

  await applyInvoiceToOrder(supabase, orderRow.id, {
    nfNumber: event.numero_nf,
    nfeXmlUrl: event.nfe_xml,
    nfeDanfeUrl: event.nfe_danfe,
    ncmByProductCode,
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/omie/webhook`
Expected: PASS, all tests green.

- [ ] **Step 5: Write the failing tests for the route**

Create `src/app/api/webhooks/omie/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const handleOmieWebhook = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ fake: true }),
}))
vi.mock('@/lib/omie/webhook', () => ({
  handleOmieWebhook: (...args: unknown[]) => handleOmieWebhook(...args),
}))

const { POST } = await import('./route')
const { NextRequest } = await import('next/server')

const PAYLOAD = { topic: 'NFe.NotaAutorizada', event: { id_pedido: 1 } }

function webhookRequest(url: string, body: unknown = PAYLOAD) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/webhooks/omie', () => {
  beforeEach(() => {
    handleOmieWebhook.mockReset()
    handleOmieWebhook.mockResolvedValue(undefined)
    process.env.OMIE_WEBHOOK_SECRET = 's3cret'
  })

  afterEach(() => {
    delete process.env.OMIE_WEBHOOK_SECRET
  })

  it('rejects a request with no secret and does no work', async () => {
    const response = await POST(webhookRequest('https://example.com/api/webhooks/omie?account=matriz'))
    expect(response.status).toBe(401)
    expect(handleOmieWebhook).not.toHaveBeenCalled()
  })

  it('rejects a request with the wrong secret', async () => {
    const response = await POST(webhookRequest('https://example.com/api/webhooks/omie?account=matriz&secret=wrong'))
    expect(response.status).toBe(401)
    expect(handleOmieWebhook).not.toHaveBeenCalled()
  })

  it('rejects everything when OMIE_WEBHOOK_SECRET is not configured', async () => {
    delete process.env.OMIE_WEBHOOK_SECRET
    const response = await POST(webhookRequest('https://example.com/api/webhooks/omie?account=matriz&secret=s3cret'))
    expect(response.status).toBe(401)
  })

  it('rejects a missing or invalid account param', async () => {
    const response = await POST(webhookRequest('https://example.com/api/webhooks/omie?secret=s3cret'))
    expect(response.status).toBe(400)
    expect(handleOmieWebhook).not.toHaveBeenCalled()

    const response2 = await POST(
      webhookRequest('https://example.com/api/webhooks/omie?secret=s3cret&account=headquarters')
    )
    expect(response2.status).toBe(400)
  })

  it('accepts a valid request and processes the payload against the right account', async () => {
    const response = await POST(webhookRequest('https://example.com/api/webhooks/omie?secret=s3cret&account=filial'))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ received: true })
    expect(handleOmieWebhook).toHaveBeenCalledWith({ fake: true }, 'filial', PAYLOAD)
  })

  it('rejects a body that is not valid JSON', async () => {
    const request = new (await import('next/server')).NextRequest(
      'https://example.com/api/webhooks/omie?secret=s3cret&account=matriz',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json' }
    )
    const response = await POST(request)
    expect(response.status).toBe(400)
    expect(handleOmieWebhook).not.toHaveBeenCalled()
  })

  it('acknowledges before webhook processing finishes and does not reject when it fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    handleOmieWebhook.mockRejectedValue(new Error('boom'))

    const response = await POST(webhookRequest('https://example.com/api/webhooks/omie?secret=s3cret&account=matriz'))

    expect(response.status).toBe(200)
    await Promise.resolve()
    consoleError.mockRestore()
  })
})
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npm test -- src/app/api/webhooks/omie`
Expected: FAIL — `./route` does not exist yet.

- [ ] **Step 7: Implement the route**

Create `src/app/api/webhooks/omie/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { handleOmieWebhook } from '@/lib/omie/webhook'
import type { OmieAccount } from '@/lib/omie/client'

export async function POST(request: NextRequest) {
  // Same pattern as the Mercado Livre webhook: Omie's webhook config lets us
  // register an arbitrary URL, so the shared secret lives in the query
  // string configured in the Developer Portal.
  const expectedSecret = process.env.OMIE_WEBHOOK_SECRET
  if (!expectedSecret || request.nextUrl.searchParams.get('secret') !== expectedSecret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Matriz and filial are two separate Omie accounts/apps, each with its
  // own webhook registration pointed at this same route with a different
  // `account` value - that's how we know which app's credentials to use,
  // rather than trusting the payload's own empresa_cnpj field.
  const account = request.nextUrl.searchParams.get('account')
  if (account !== 'matriz' && account !== 'filial') {
    return NextResponse.json({ error: 'invalid_account' }, { status: 400 })
  }

  let payload
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  // Acknowledge immediately, same rationale as the Mercado Livre webhook
  // route: handleOmieWebhook has its own error handling, and a slow ACK
  // risks the webhook being considered failed or disabled upstream.
  void handleOmieWebhook(createServiceClient(), account as OmieAccount, payload).catch((error) => {
    console.error('Omie webhook processing failed:', error)
  })

  return NextResponse.json({ received: true })
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test -- src/app/api/webhooks/omie`
Expected: PASS, all tests green.

- [ ] **Step 9: Add the new env var to `.env.example`**

Append to `.env.example`:

```
# Shared secret appended to the notification URL registered in each Omie
# app's Developer Portal (both matriz and filial), e.g.:
# https://salfhcosmeticos.tech/api/webhooks/omie?account=matriz&secret=<this value>
# https://salfhcosmeticos.tech/api/webhooks/omie?account=filial&secret=<this value>
OMIE_WEBHOOK_SECRET=
```

- [ ] **Step 10: Commit**

```bash
git add src/lib/omie/webhook.ts src/lib/omie/webhook.test.ts src/app/api/webhooks/omie/route.ts src/app/api/webhooks/omie/route.test.ts .env.example
git commit -m "feat: add the Omie NFe.NotaAutorizada webhook handler and route"
```

---

### Task 5: Pending-invoice sweep + cron wiring

**Files:**
- Create: `src/lib/omie/pendingInvoices.ts`
- Create: `src/lib/omie/pendingInvoices.test.ts`
- Modify: `src/lib/mercadolivre/cron.ts`

**Interfaces:**
- Consumes: Task 1's `pending_omie_invoices` table; Task 4's `applyInvoiceToOrder`.
- Produces: `export async function applyPendingOmieInvoices(supabase: SupabaseClient): Promise<{ processed: number; errors: number }>` — consumed by `cron.ts` in this task.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/omie/pendingInvoices.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyPendingOmieInvoices } from './pendingInvoices'

function createFakeSupabase(pending: Record<string, unknown>[], orderByMlId: Record<string, { id: string }>) {
  const deletedIds: string[] = []
  const orderUpdateCalls: unknown[] = []
  const itemsUpsertCalls: unknown[] = []

  const supabaseClient = {
    from(table: string) {
      if (table === 'pending_omie_invoices') {
        return {
          select: async () => ({ data: pending, error: null }),
          delete: () => ({
            eq: async (_col: string, id: string) => {
              deletedIds.push(id)
              return { error: null }
            },
          }),
        }
      }
      if (table === 'orders') {
        return {
          select: () => ({
            eq: (_col: string, mlOrderId: number) => ({
              maybeSingle: async () => ({ data: orderByMlId[String(mlOrderId)] ?? null, error: null }),
            }),
          }),
          update: (data: unknown) => ({
            eq: async (_col: string, id: string) => {
              orderUpdateCalls.push({ data, id })
              return { error: null }
            },
          }),
        }
      }
      if (table === 'order_items') {
        return {
          select: () => ({ eq: async () => ({ data: [], error: null }) }),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
  }

  return { client: supabaseClient as unknown as SupabaseClient, deletedIds, orderUpdateCalls, itemsUpsertCalls }
}

describe('applyPendingOmieInvoices', () => {
  it('applies and deletes a pending row whose order has since been synced', async () => {
    const pending = [
      {
        id: 'pending-1',
        ml_order_id: 2000017307031470,
        nf_number: '00037493',
        nfe_xml_url: 'https://cdn.omie.com.br/x',
        nfe_danfe_url: 'https://cdn.omie.com.br/p',
        ncm_by_product_code: { SF9004: '33059000' },
      },
    ]
    const { client: supabase, deletedIds, orderUpdateCalls } = createFakeSupabase(pending, {
      '2000017307031470': { id: 'order-row-1' },
    })

    const result = await applyPendingOmieInvoices(supabase)

    expect(result).toEqual({ processed: 1, errors: 0 })
    expect(deletedIds).toEqual(['pending-1'])
    expect(orderUpdateCalls[0]).toMatchObject({ id: 'order-row-1', data: expect.objectContaining({ nf_number: '00037493' }) })
  })

  it('leaves a pending row untouched (not deleted, not an error) when its order still is not synced', async () => {
    const pending = [
      {
        id: 'pending-1',
        ml_order_id: 999,
        nf_number: '1',
        nfe_xml_url: null,
        nfe_danfe_url: null,
        ncm_by_product_code: {},
      },
    ]
    const { client: supabase, deletedIds } = createFakeSupabase(pending, {})

    const result = await applyPendingOmieInvoices(supabase)

    expect(result).toEqual({ processed: 0, errors: 0 })
    expect(deletedIds).toEqual([])
  })

  it('returns processed: 0, errors: 0 when there are no pending rows', async () => {
    const { client: supabase } = createFakeSupabase([], {})

    expect(await applyPendingOmieInvoices(supabase)).toEqual({ processed: 0, errors: 0 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/omie/pendingInvoices`
Expected: FAIL — `./pendingInvoices` does not exist yet.

- [ ] **Step 3: Implement**

Create `src/lib/omie/pendingInvoices.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyInvoiceToOrder } from './webhook'

export async function applyPendingOmieInvoices(supabase: SupabaseClient): Promise<{ processed: number; errors: number }> {
  let processed = 0
  let errors = 0

  const { data: pending, error: queryError } = await supabase.from('pending_omie_invoices').select('*')

  if (queryError) {
    return { processed: 0, errors: 1 }
  }

  for (const row of pending ?? []) {
    try {
      const { data: orderRow } = await supabase
        .from('orders')
        .select('id')
        .eq('ml_order_id', row.ml_order_id)
        .maybeSingle()

      if (!orderRow) continue // still not synced from Mercado Livre - try again next sweep, not an error

      await applyInvoiceToOrder(supabase, orderRow.id, {
        nfNumber: row.nf_number,
        nfeXmlUrl: row.nfe_xml_url,
        nfeDanfeUrl: row.nfe_danfe_url,
        ncmByProductCode: row.ncm_by_product_code,
      })

      await supabase.from('pending_omie_invoices').delete().eq('id', row.id)
      processed += 1
    } catch {
      errors += 1
    }
  }

  return { processed, errors }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/omie/pendingInvoices`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Wire into the cron**

Replace the full contents of `src/lib/mercadolivre/cron.ts` with:

```ts
import cron from 'node-cron'
import { createServiceClient } from '@/lib/supabase/server'
import { reconcileRecentOrders, type StoredMercadoLivreAccount } from './sync'
import { applyPendingOmieInvoices } from '@/lib/omie/pendingInvoices'

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
    }

    // Account-agnostic (matches by ml_order_id, not tied to a specific
    // marketplace_accounts row) - runs once per tick, not once per account.
    await applyPendingOmieInvoices(supabase)
  })
}
```

There is no existing test file for `cron.ts` (it wires a real `node-cron` schedule, not something previously unit-tested in this codebase) — this task does not add one, consistent with that.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS (this step doesn't change behavior covered by existing tests, just confirms nothing broke).

- [ ] **Step 7: Commit**

```bash
git add src/lib/omie/pendingInvoices.ts src/lib/omie/pendingInvoices.test.ts src/lib/mercadolivre/cron.ts
git commit -m "feat: add the pending-Omie-invoice sweep and wire it into the reconciliation cron"
```

---

### Task 6: Stop polling Omie at Mercado Livre sync time

**Files:**
- Modify: `src/lib/mercadolivre/sync.ts`
- Modify: `src/lib/mercadolivre/sync.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `upsertOrder`'s signature and behavior for every field except `nf_number`/`nf_fetched_at`/`ncm` is unchanged — those three are no longer written by `upsertOrder` at all (the webhook/pending-sweep/backfill own them from now on). `retryPendingFiscalDocuments` is deleted; nothing in the codebase calls it after this task (Task 5 already replaced its role in `cron.ts`).

**Why this matters, precisely:** `upsertOrder`'s `orders`/`order_items` upserts must **omit** the `nf_number`, `nf_fetched_at`, and `ncm` keys entirely from the payload object — not set them to `null`. Supabase's `upsert` only updates the columns present in the payload; a key that's present with value `null` will *overwrite* a value the webhook already wrote the moment this order gets re-synced (e.g. by the 15-minute reconciliation pass), silently erasing real invoice data. Omitting the key entirely leaves the existing column value untouched on conflict.

- [ ] **Step 1: Write the failing test that pins the omission**

In `src/lib/mercadolivre/sync.test.ts`, this task makes extensive changes. Start with this one, added inside `describe('upsertOrder - margin data', ...)`, right after the `'stores commission as the sum of each item sale_fee'` test:

```ts
  it('does not include nf_number/nf_fetched_at on the orders upsert or ncm on the order_items upsert - the Omie webhook writes those later, not sync time', async () => {
    const { client: supabase, orderUpsertCalls, itemsUpsertCalls } = createFakeSupabase()
    const order: MercadoLivreOrder = {
      ...sampleOrder,
      items: [{ mlItemId: 'MLB1', title: 'Produto', quantity: 1, unitPrice: 150, saleFee: 0, sellerSku: 'SF9004' }],
    }

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', order)

    expect(orderUpsertCalls[0].data).not.toHaveProperty('nf_number')
    expect(orderUpsertCalls[0].data).not.toHaveProperty('nf_fetched_at')
    expect(itemsUpsertCalls[0].data[0]).not.toHaveProperty('ncm')
    expect(itemsUpsertCalls[0].data[0]).toMatchObject({ product_code: 'SF9004' })
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- sync.test.ts -t "does not include nf_number"`
Expected: FAIL — `upsertOrder` still writes `nf_number: null`, `nf_fetched_at: null`, `ncm: null` today.

- [ ] **Step 3: Remove the Omie lookup from `upsertOrder`**

In `src/lib/mercadolivre/sync.ts`, replace the import block:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { subMonths } from 'date-fns'
import type { MercadoLivreOrder } from './client'
import { getValidAccessToken, searchOrders, getOrder, getShipmentAddress, getShipmentSellerCost, getBillingInfo } from './client'
import { lookupInvoice } from '../omie/client'
```

with:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { subMonths } from 'date-fns'
import type { MercadoLivreOrder } from './client'
import { getValidAccessToken, searchOrders, getOrder, getShipmentAddress, getShipmentSellerCost, getBillingInfo } from './client'
```

Replace the fiscal-document block inside `upsertOrder` (everything between the `buyerName` try/catch and the `orders` upsert):

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

  const { data: orderRow, error: orderError } = await supabase
```

with:

```ts
  const { data: orderRow, error: orderError } = await supabase
```

Replace the `orders` upsert object:

```ts
        destination_city: destinationCity,
        destination_state: destinationState,
        logistic_type: logisticType,
        buyer_name: buyerName,
        sales_channel: order.salesChannel,
        nf_number: nfNumber,
        nf_fetched_at: nfFetchedAt,
      },
```

with:

```ts
        destination_city: destinationCity,
        destination_state: destinationState,
        logistic_type: logisticType,
        buyer_name: buyerName,
        sales_channel: order.salesChannel,
      },
```

Replace the `itemRows` mapping:

```ts
  const itemRows = order.items.map((item) => ({
    order_id: orderRow.id,
    user_id: userId,
    ml_item_id: item.mlItemId,
    title: item.title,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    product_code: item.sellerSku,
    ncm: item.sellerSku ? (ncmByProductCode[item.sellerSku] ?? null) : null,
  }))
```

with:

```ts
  const itemRows = order.items.map((item) => ({
    order_id: orderRow.id,
    user_id: userId,
    ml_item_id: item.mlItemId,
    title: item.title,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    product_code: item.sellerSku,
  }))
```

- [ ] **Step 4: Delete `retryPendingFiscalDocuments`**

Delete the entire function from `src/lib/mercadolivre/sync.ts` — everything from its `export async function retryPendingFiscalDocuments(` line through its closing `}` (the last function in the file).

- [ ] **Step 5: Run the pinning test to verify it passes**

Run: `npm test -- sync.test.ts -t "does not include nf_number"`
Expected: PASS.

- [ ] **Step 6: Remove the now-obsolete tests from `sync.test.ts`**

Still in `describe('upsertOrder - margin data', ...)`, delete these tests entirely (their behavior no longer exists in `upsertOrder`):
- `'leaves nf_number and nf_fetched_at null and does not throw when no invoice is found'`
- `'sets nf_number, nf_fetched_at, product_code and ncm (matched by product code) when an invoice is found'`
- `'matches ncm per item by product code, leaving unmatched items null, regardless of item-count differences'`
- `'looks up the invoice in the filial Omie account when logistic_type is "fulfillment"'`
- `'looks up the invoice in the matriz Omie account for any logistic_type other than "fulfillment", including null'`

Replace the `'stores product_code from sellerSku even when no invoice is found yet, and leaves ncm null'` test with:

```ts
  it('stores product_code from sellerSku', async () => {
    const { client: supabase, itemsUpsertCalls } = createFakeSupabase()
    const order: MercadoLivreOrder = {
      ...sampleOrder,
      items: [{ mlItemId: 'MLB1', title: 'Produto', quantity: 1, unitPrice: 150, saleFee: 0, sellerSku: 'SF9004' }],
    }

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', order)

    expect(itemsUpsertCalls[0]).toMatchObject({
      data: [expect.objectContaining({ product_code: 'SF9004' })],
    })
  })
```

Replace the `'leaves product_code and ncm null when the item has no seller SKU set on Mercado Livre'` test with:

```ts
  it('leaves product_code null when the item has no seller SKU set on Mercado Livre', async () => {
    const { client: supabase, itemsUpsertCalls } = createFakeSupabase()
    const order: MercadoLivreOrder = {
      ...sampleOrder,
      items: [{ mlItemId: 'MLB1', title: 'Produto', quantity: 1, unitPrice: 150, saleFee: 0, sellerSku: null }],
    }

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', order)

    expect(itemsUpsertCalls[0]).toMatchObject({
      data: [expect.objectContaining({ product_code: null })],
    })
  })
```

Then delete the entire `describe('retryPendingFiscalDocuments', ...)` block (it's the last top-level `describe` in the file — everything from that line to the file's closing, minus the final newline).

Finally, remove the now-unused `omieClient` spy from the top-level `beforeEach` — replace:

```ts
beforeEach(() => {
  vi.spyOn(client, 'getBillingInfo').mockResolvedValue({ buyerName: null })
  vi.spyOn(omieClient, 'lookupInvoice').mockResolvedValue(null)
})
```

with:

```ts
beforeEach(() => {
  vi.spyOn(client, 'getBillingInfo').mockResolvedValue({ buyerName: null })
})
```

And remove the now-unused import — replace:

```ts
import * as client from './client'
import * as omieClient from '../omie/client'
```

with:

```ts
import * as client from './client'
```

And remove `retryPendingFiscalDocuments` from the top-of-file import list — replace:

```ts
import {
  upsertOrder,
  backfillOrders,
  buildMonthlyWindows,
  handleMercadoLivreWebhook,
  reconcileRecentOrders,
  retryPendingFiscalDocuments,
} from './sync'
```

with:

```ts
import { upsertOrder, backfillOrders, buildMonthlyWindows, handleMercadoLivreWebhook, reconcileRecentOrders } from './sync'
```

- [ ] **Step 7: Run the full file and the full suite**

Run: `npm test -- sync.test.ts`
Expected: PASS, every remaining test in the file green.

Run: `npm test`
Expected: PASS, no failures anywhere else in the repo.

Run: `npx tsc --noEmit`
Expected: no errors referencing `sync.ts`, `sync.test.ts`, or `lookupInvoice`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/mercadolivre/sync.ts src/lib/mercadolivre/sync.test.ts
git commit -m "feat: stop polling Omie at Mercado Livre sync time; the webhook owns NF/NCM now"
```

---

### Task 7: One-time Omie backfill route

**Files:**
- Create: `src/app/api/omie/backfill/route.ts`
- Create: `src/app/api/omie/backfill/route.test.ts`

**Interfaces:**
- Consumes: Task 3's `listarPedidos`, `listarNF`, `obterNfe`, `formatOmieDate`; Task 2's `parseOmieNfeXml`; Task 4's `applyInvoiceToOrder`.
- Produces: `POST /api/omie/backfill` — consumed manually during rollout (Task 9), not by any other code.

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/omie/backfill/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const getUser = vi.fn()
const listarPedidos = vi.fn()
const listarNF = vi.fn()
const obterNfe = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({ auth: { getUser } }),
  createServiceClient: () => fakeServiceClient,
}))
vi.mock('@/lib/omie/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/omie/client')>()
  return { ...actual, listarPedidos, listarNF, obterNfe }
})

let pendingOrders: { id: string; ml_order_id: number; order_date: string; logistic_type: string | null }[] = []
const orderUpdateCalls: unknown[] = []

const fakeServiceClient = {
  from(table: string) {
    if (table === 'orders') {
      return {
        select: () => ({ is: async () => ({ data: pendingOrders, error: null }) }),
        update: (data: unknown) => ({
          eq: async (_col: string, id: string) => {
            orderUpdateCalls.push({ data, id })
            return { error: null }
          },
        }),
      }
    }
    if (table === 'order_items') {
      return { select: () => ({ eq: async () => ({ data: [], error: null }) }) }
    }
    throw new Error(`Unexpected table: ${table}`)
  },
} as unknown as SupabaseClient

const { POST } = await import('./route')
const { NextRequest } = await import('next/server')

function backfillRequest() {
  return new NextRequest('https://example.com/api/omie/backfill', { method: 'POST' })
}

describe('POST /api/omie/backfill', () => {
  beforeEach(() => {
    getUser.mockReset()
    listarPedidos.mockReset()
    listarNF.mockReset()
    obterNfe.mockReset()
    pendingOrders = []
    orderUpdateCalls.length = 0
  })

  it('rejects an unauthenticated request', async () => {
    getUser.mockResolvedValue({ data: { user: null } })

    const response = await POST(backfillRequest())

    expect(response.status).toBe(401)
    expect(listarPedidos).not.toHaveBeenCalled()
  })

  it('finds and applies an invoice for a pending order via the two-stage lookup', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    pendingOrders = [{ id: 'order-1', ml_order_id: 2000017307031470, order_date: '2026-07-07T22:21:00.000Z', logistic_type: null }]
    listarPedidos.mockResolvedValue({
      totalPaginas: 1,
      pedidos: [{ codigoPedido: 11248244211, numeroPedidoCliente: '2000017307031470' }],
    })
    listarNF.mockResolvedValue({ totalPaginas: 1, notas: [{ nIdNf: 11248244216, nIdPedido: 11248244211 }] })
    obterNfe.mockResolvedValue({
      invoiceNumber: '00031513',
      chaveNfe: '412...',
      xml:
        '<?xml version="1.0"?><nfeProc><NFe><infNFe><ide><nNF>31513</nNF></ide>' +
        '<det nItem="1"><prod><cProd>SF9004</cProd><NCM>33059000</NCM></prod></det></infNFe></NFe></nfeProc>',
      pdfUrl: 'https://click.omie.com/pdf',
    })

    const response = await POST(backfillRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ processed: 1, errors: 0 })
    expect(listarPedidos).toHaveBeenCalledWith('matriz', 1, expect.any(String), expect.any(String))
    expect(orderUpdateCalls[0]).toMatchObject({
      id: 'order-1',
      data: expect.objectContaining({ nf_number: '00031513', nfe_danfe_url: 'https://click.omie.com/pdf' }),
    })
  })

  it('tries the other Omie account when the first (per logistic_type) has no match', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    pendingOrders = [{ id: 'order-1', ml_order_id: 111, order_date: '2026-07-07T00:00:00.000Z', logistic_type: 'fulfillment' }]
    listarPedidos
      .mockResolvedValueOnce({ totalPaginas: 1, pedidos: [] }) // filial (first, per logistic_type) - no match
      .mockResolvedValueOnce({ totalPaginas: 1, pedidos: [{ codigoPedido: 1, numeroPedidoCliente: '111' }] }) // matriz

    listarNF.mockResolvedValue({ totalPaginas: 1, notas: [{ nIdNf: 5, nIdPedido: 1 }] })
    obterNfe.mockResolvedValue({
      invoiceNumber: '1',
      chaveNfe: '412...',
      xml: '<?xml version="1.0"?><nfeProc><NFe><infNFe><ide><nNF>1</nNF></ide></infNFe></NFe></nfeProc>',
      pdfUrl: 'https://click.omie.com/pdf',
    })

    const response = await POST(backfillRequest())

    await expect(response.json()).resolves.toEqual({ processed: 1, errors: 0 })
    expect(listarPedidos).toHaveBeenNthCalledWith(1, 'filial', 1, expect.any(String), expect.any(String))
    expect(listarPedidos).toHaveBeenNthCalledWith(2, 'matriz', 1, expect.any(String), expect.any(String))
  })

  it('counts an order as neither processed nor an error when no Pedido is found in either account', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    pendingOrders = [{ id: 'order-1', ml_order_id: 999, order_date: '2026-07-07T00:00:00.000Z', logistic_type: null }]
    listarPedidos.mockResolvedValue({ totalPaginas: 1, pedidos: [] })

    const response = await POST(backfillRequest())

    await expect(response.json()).resolves.toEqual({ processed: 0, errors: 0 })
  })

  it('isolates a per-order failure so the rest of the batch still processes', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    pendingOrders = [
      { id: 'order-fail', ml_order_id: 1, order_date: '2026-07-07T00:00:00.000Z', logistic_type: null },
      { id: 'order-ok', ml_order_id: 2, order_date: '2026-07-07T00:00:00.000Z', logistic_type: null },
    ]
    listarPedidos
      .mockRejectedValueOnce(new Error('Omie API error on ListarPedidos: 500'))
      .mockResolvedValueOnce({ totalPaginas: 1, pedidos: [{ codigoPedido: 1, numeroPedidoCliente: '2' }] })
    listarNF.mockResolvedValue({ totalPaginas: 1, notas: [{ nIdNf: 1, nIdPedido: 1 }] })
    obterNfe.mockResolvedValue({
      invoiceNumber: '1',
      chaveNfe: '412...',
      xml: '<?xml version="1.0"?><nfeProc><NFe><infNFe><ide><nNF>1</nNF></ide></infNFe></NFe></nfeProc>',
      pdfUrl: 'https://click.omie.com/pdf',
    })

    const response = await POST(backfillRequest())

    await expect(response.json()).resolves.toEqual({ processed: 1, errors: 1 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/app/api/omie/backfill`
Expected: FAIL — `./route` does not exist yet.

- [ ] **Step 3: Implement**

Create `src/app/api/omie/backfill/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { listarPedidos, listarNF, obterNfe, formatOmieDate, type OmieAccount } from '@/lib/omie/client'
import { parseOmieNfeXml } from '@/lib/omie/nfe'
import { applyInvoiceToOrder } from '@/lib/omie/webhook'

const WINDOW_DAYS = 10
const PAGE_DELAY_MS = 150

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function findCodigoPedido(
  account: OmieAccount,
  mlOrderId: number,
  fromDate: Date,
  toDate: Date
): Promise<number | null> {
  let pagina = 1
  let totalPaginas = 1
  do {
    const page = await listarPedidos(account, pagina, formatOmieDate(fromDate), formatOmieDate(toDate))
    totalPaginas = page.totalPaginas
    const match = page.pedidos.find((p) => p.numeroPedidoCliente === String(mlOrderId))
    if (match) return match.codigoPedido
    pagina += 1
    if (pagina <= totalPaginas) await wait(PAGE_DELAY_MS)
  } while (pagina <= totalPaginas)
  return null
}

async function findNIdNf(account: OmieAccount, codigoPedido: number, fromDate: Date, toDate: Date): Promise<number | null> {
  let pagina = 1
  let totalPaginas = 1
  do {
    const page = await listarNF(account, pagina, formatOmieDate(fromDate), formatOmieDate(toDate))
    totalPaginas = page.totalPaginas
    const match = page.notas.find((nf) => nf.nIdPedido === codigoPedido)
    if (match) return match.nIdNf
    pagina += 1
    if (pagina <= totalPaginas) await wait(PAGE_DELAY_MS)
  } while (pagina <= totalPaginas)
  return null
}

// One-time, admin-triggered backfill for orders invoiced before the
// NFe.NotaAutorizada webhooks existed. Not a cron - everything going
// forward is covered by the webhook (src/app/api/webhooks/omie/route.ts)
// and its pending-invoice sweep (src/lib/omie/pendingInvoices.ts).
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 })
  }

  const serviceClient = createServiceClient()

  const { data: pendingOrders, error: queryError } = await serviceClient
    .from('orders')
    .select('id, ml_order_id, order_date, logistic_type')
    .is('nf_fetched_at', null)

  if (queryError) {
    return NextResponse.json({ error: queryError.message }, { status: 500 })
  }

  let processed = 0
  let errors = 0

  for (const order of pendingOrders ?? []) {
    try {
      const orderDate = new Date(order.order_date)
      const windowEnd = new Date(orderDate.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000)
      const firstAccount: OmieAccount = order.logistic_type === 'fulfillment' ? 'filial' : 'matriz'
      const secondAccount: OmieAccount = firstAccount === 'filial' ? 'matriz' : 'filial'

      let account = firstAccount
      let codigoPedido = await findCodigoPedido(firstAccount, order.ml_order_id, orderDate, windowEnd)
      if (codigoPedido === null) {
        account = secondAccount
        codigoPedido = await findCodigoPedido(secondAccount, order.ml_order_id, orderDate, windowEnd)
      }
      if (codigoPedido === null) continue // not invoiced yet, or outside the window - not an error

      const nIdNf = await findNIdNf(account, codigoPedido, orderDate, windowEnd)
      if (nIdNf === null) continue

      const nfe = await obterNfe(account, nIdNf)
      const invoice = parseOmieNfeXml(nfe.xml)
      const ncmByProductCode = Object.fromEntries(invoice.items.map((item) => [item.productCode, item.ncm]))

      await applyInvoiceToOrder(serviceClient, order.id, {
        nfNumber: nfe.invoiceNumber,
        // ObterNfe returns the XML content directly, not a link - there is
        // no URL to store for backfilled orders (unlike the webhook path,
        // which gets a direct CDN link in the event payload).
        nfeXmlUrl: null,
        nfeDanfeUrl: nfe.pdfUrl,
        ncmByProductCode,
      })

      processed += 1
    } catch {
      errors += 1
    }
  }

  return NextResponse.json({ processed, errors })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/app/api/omie/backfill`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/omie/backfill/route.ts src/app/api/omie/backfill/route.test.ts
git commit -m "feat: add the one-time Omie backfill route for pre-webhook pending invoices"
```

---

### Task 8: Margin page — link the NF cell, rename the stale "aguardando XML" label

**Files:**
- Modify: `src/app/(dashboard)/margem-contribuicao/page.tsx`

**Interfaces:**
- Consumes: Task 1's `orders.nfe_danfe_url` column.
- Produces: no new exports — page-level rendering change only.

- [ ] **Step 1: Implement**

In `src/app/(dashboard)/margem-contribuicao/page.tsx`, replace the `OrderRow` interface's `nfNumber` line:

```ts
  nfNumber: string | null
```

with:

```ts
  nfNumber: string | null
  nfeDanfeUrl: string | null
```

Replace the Supabase `.select(...)` string:

```ts
      .select(
        'id, ml_order_id, order_date, total_amount, ml_commission, shipping_or_fee_amount, shipping_or_fee_type, destination_state, destination_city, logistic_type, buyer_name, sales_channel, nf_number, nf_fetched_at, order_items(ml_item_id, product_code, title, quantity, unit_price, ncm)'
      )
```

with:

```ts
      .select(
        'id, ml_order_id, order_date, total_amount, ml_commission, shipping_or_fee_amount, shipping_or_fee_type, destination_state, destination_city, logistic_type, buyer_name, sales_channel, nf_number, nf_fetched_at, nfe_danfe_url, order_items(ml_item_id, product_code, title, quantity, unit_price, ncm)'
      )
```

Replace the row-mapping's `nfNumber` line:

```ts
    nfNumber: order.nf_number as string | null,
```

with:

```ts
    nfNumber: order.nf_number as string | null,
    nfeDanfeUrl: order.nfe_danfe_url as string | null,
```

Replace the NF table cell:

```tsx
                  <TableCell>{row.nfPending ? 'aguardando XML' : row.nfNumber}</TableCell>
```

with:

```tsx
                  <TableCell>
                    {row.nfPending ? (
                      'aguardando nota fiscal'
                    ) : row.nfeDanfeUrl ? (
                      <a href={row.nfeDanfeUrl} target="_blank" rel="noreferrer" className="underline">
                        {row.nfNumber}
                      </a>
                    ) : (
                      row.nfNumber
                    )}
                  </TableCell>
```

Replace the two remaining `'aguardando XML'` occurrences (the ICMS debit and net profit cells):

```tsx
                  <TableCell className="text-right">
                    {margin.icmsDebit === null ? 'aguardando XML' : formatCurrencyBRL(margin.icmsDebit)}
                  </TableCell>
                  <TableCell className="text-right">
                    {margin.netProfit === null ? 'aguardando XML' : formatCurrencyBRL(margin.netProfit)}
                  </TableCell>
```

with:

```tsx
                  <TableCell className="text-right">
                    {margin.icmsDebit === null ? 'aguardando nota fiscal' : formatCurrencyBRL(margin.icmsDebit)}
                  </TableCell>
                  <TableCell className="text-right">
                    {margin.netProfit === null ? 'aguardando nota fiscal' : formatCurrencyBRL(margin.netProfit)}
                  </TableCell>
```

And the margin % cell:

```tsx
                    {margin.marginPct === null
                      ? productCost === null
                        ? 'custo não cadastrado'
                        : 'aguardando XML'
                      : `${margin.marginPct.toFixed(1)}%`}
```

with:

```tsx
                    {margin.marginPct === null
                      ? productCost === null
                        ? 'custo não cadastrado'
                        : 'aguardando nota fiscal'
                      : `${margin.marginPct.toFixed(1)}%`}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(dashboard)/margem-contribuicao/page.tsx"
git commit -m "feat: link the NF cell to the DANFE and drop the stale 'aguardando XML' wording"
```

---

### Task 9: Rollout — env vars, migration, webhooks, backfill, verification

**Files:** none (operational task).

- [ ] **Step 1: Set the new env var**

Generate a random value for `OMIE_WEBHOOK_SECRET` and set it in `.env.local` locally, then in the production environment (EasyPanel), same as the other secrets.

- [ ] **Step 2: Confirm `ConsultarPedido`'s real response shape**

Per this plan's Global Constraints, `ConsultarPedido`'s `informacoes_adicionais` field is unconfirmed. Make one real call (`consultarPedido('matriz', <a known codigo_pedido>)`, e.g. via a throwaway script) against a real Pedido and compare the response against `OmiePedidoVendaProduto` in `src/lib/omie/client.ts`. If the shape differs, fix the interface and `consultarPedido`'s mapping, and re-run `npm test -- src/lib/omie/client` with adjusted fixtures.

- [ ] **Step 3: Register the two new webhooks**

In each Omie account's Developer Portal (matriz app, App Key `6188772477888`; filial app, App Key `7779581220411`) — **without touching the existing "Weesutech" webhook already registered there** — click "Adicionar novo webhook" and register:

```
https://salfhcosmeticos.tech/api/webhooks/omie?account=matriz&secret=<OMIE_WEBHOOK_SECRET>
```
(in the matriz app) and
```
https://salfhcosmeticos.tech/api/webhooks/omie?account=filial&secret=<OMIE_WEBHOOK_SECRET>
```
(in the filial app), both subscribed to topic `NFe.NotaAutorizada`.

- [ ] **Step 4: Run the one-time backfill**

Once deployed, call `POST /api/omie/backfill` (authenticated as the owner) once. Confirm the response's `processed`/`errors` counts look reasonable, and spot-check a few previously-"aguardando nota fiscal" orders on the Margem de contribuição page now show a real NF number and a working DANFE link.

- [ ] **Step 5: Manual smoke test of the webhook path**

Wait for (or trigger, if there's a way to do so safely) a new real invoice to be authorized in either Omie account. Confirm: the webhook fires, `sync_runs`/application logs show no errors, the corresponding order's row updates with `nf_number`/`nfe_xml_url`/`nfe_danfe_url`, and its items show a real `ncm`. If the order hadn't synced from Mercado Livre yet at that moment, confirm it lands in `pending_omie_invoices` and gets applied within one 15-minute cron tick after the order does sync.

- [ ] **Step 6: Confirm the Weesutech webhook is untouched**

Re-open both Developer Portal webhook lists and confirm the original Weesutech webhook (`https://api-receive-notify-omie.croversp.weesutech.com.br/v2/omie`) is still present, unmodified, in both accounts.

This closes the "P" (Plano) stage for this rework. Per the project's standing workflow, the next stage is "A" (Auditoria): run `/code-review` and a security review before merging/deploying — pay particular attention to the new webhook route's secret check (same pattern as the existing Mercado Livre webhook, already reviewed once), the `pending_omie_invoices` table's lack of a select policy (intentional — service-role-only), and whether `upsertOrder`'s omitted-not-nulled fields genuinely can't regress to null on a re-sync (Task 6's core correctness point).
