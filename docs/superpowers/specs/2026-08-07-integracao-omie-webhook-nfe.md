# Integração com a Omie via webhook para NCM e XML da nota fiscal — design

**Date:** 2026-08-07
**Status:** implemented (all 8 code tasks shipped and reviewed 2026-08-07); rollout (Task 9 of the plan) pending
**Supersedes:** the "Fetching the invoice" and "Two Omie accounts, chosen by fulfillment type" sections of `2026-08-06-integracao-omie-notas-fiscais-design.md`, and everything built against them in `src/lib/omie/client.ts` (Task 3 of `docs/superpowers/plans/2026-08-06-integracao-omie-notas-fiscais.md`). That spec assumed a single `ConsultarNF`/`ListarNF` call against Omie's `produtos/nfconsultar/` endpoint could resolve an order's invoice directly. Live testing this session (2026-08-06/07, against the real matriz/filial Omie accounts and a real Mercado Livre order, `2000017307031470`) found that design wrong in several load-bearing ways — see "What we learned this session" below — and found a materially better, webhook-driven alternative in the process. This spec replaces the whole lookup design; the rest of the parent spec (margin calculation split by CNPJ, no-write constraint, no settings UI, Mercado Livre only) is unchanged.

## What we learned this session (context for the design below)

All of this was confirmed against production — the owner's real Omie accounts, a real Mercado Livre order, and Omie's own support team — not inferred from documentation alone:

1. **The Mercado Livre order number lives on the Pedido de Venda, not the Nota Fiscal.** It's in `informacoes_adicionais.numero_pedido_cliente` on the Pedido de Venda object (`produtos/pedido/` endpoint), not anywhere on the Nota Fiscal object (`produtos/nfconsultar/`). Confirmed by Omie support: there is **no API filter for this field** — finding a Pedido by it requires paging through `ListarPedidos` and matching client-side. This is real and unavoidable for *past* orders (see "Backfill" below), but not a problem going forward, because of point 4.
2. **`codigo_pedido_integracao`** — the field textbook Omie integrations use to store an external order id — **is not populated with the Mercado Livre order number in this account**. It holds a different value (confirmed: the Mercado Livre shipment/pack id, e.g. `"14857629"`, not the order id `"2000017307031470"`). This is because the existing automatic Mercado Livre → Omie sync in this account is run by a **third-party integration hub, "Weesutech"** (confirmed by the owner — endpoint `https://api-receive-notify-omie.croversp.weesutech.com.br/v2/omie`, visible as an existing, active webhook registration in both Omie apps), which chose to populate `numero_pedido_cliente` instead. **This third-party webhook must not be modified or removed** — it is live production infrastructure this project does not own.
3. **`ObterNfe`**, at a different Omie endpoint (`produtos/dfedocs/`, not `produtos/nfconsultar/`), takes `{ nIdNfe: <internal NFe id> }` and returns `cNumNfe`, `nChaveNfe`, `dDataEmisNfe`, `cCodStatus`/`cDesStatus`, **`cXmlNfe`** (the full NFe XML, HTML-entity-encoded), and **`cPdf`** (a DANFE PDF link). Confirmed live against the real note for order `2000017307031470` — every field matched independently-obtained values exactly.
4. **Omie has a webhook topic, `NFe.NotaAutorizada`, that fires the moment an invoice is authorized** — and it delivers almost everything needed directly, without any lookup at all. A real, production example (pulled from the existing Weesutech webhook's delivery history in the Omie Developer Portal — "Exibir logs de integração" → "Webhooks" tab):
   ```json
   {
     "messageId": "a256eee5-bd23-46b2-b781-a1fe6b5c3c76",
     "topic": "NFe.NotaAutorizada",
     "event": {
       "acao": "autorizada",
       "ambiente": "P",
       "data_emis": "2026-08-07T00:00:00-03:00",
       "empresa_cnpj": "16864672000185",
       "empresa_ie": "9080372431",
       "empresa_uf": "PR",
       "hora_emis": "12:25:26",
       "id_nf": 11268650821,
       "id_pedido": 11268650737,
       "nfe_chave": "41260816864672000185550070000374931809980895",
       "nfe_danfe": "https://cdn.omie.com.br/repository/.../...",
       "nfe_xml": "https://cdn.omie.com.br/repository/.../...",
       "numero_nf": "00037493",
       "operacao": "11",
       "serie": "007"
     },
     "author": { "email": "no-reply@omie.com.br", "name": "Integração", "userId": 89 },
     "appKey": "6188772477888",
     "appHash": "salfh-b5hqprgt",
     "origin": "omie-connect-2.0"
   }
   ```
   `event.id_pedido` is the Pedido de Venda's internal id (`cabecalho.codigo_pedido` in `ConsultarPedido`'s response). `event.id_nf` is `nIdNfe` for `ObterNfe`. `event.nfe_xml`/`nfe_danfe` are direct CDN links to the XML/PDF — no `ObterNfe` call needed for the common case. `event.empresa_cnpj` says which CNPJ issued it. **The only thing missing is the Mercado Livre order number itself** — the event has Omie's internal `id_pedido`, not `numero_pedido_cliente`. Closing that gap costs exactly one direct, reliable call (`ConsultarPedido`), not a scan.
5. **Rate limits, confirmed via Omie's own docs** (https://ajuda.omie.com.br/pt-BR/articles/8112984): 240 requests/min per IP+AppKey+Method (4 simultaneous), max **100 records per page** (this session's testing used only 50 — avoidable overhead). Critically: **10 failed/error requests in a row to the same IP+AppKey+Method triggers a 30-minute block (HTTP 425)**. This — not raw volume — is almost certainly what happened during this session's polling tests, which repeated `ConsultarNF` calls that reliably returned HTTP 500 faults for a code that was never populated. Lesson for the backfill design below: do the bulk of the work through calls that return a normal 200 with an empty result when nothing matches (`ListarPedidos`, `ListarNF`), and only call something that can fault (`ConsultarNF`, `ConsultarPedido` by an id that might not exist) when success is expected.
6. **Matriz and filial are two entirely separate Omie accounts/apps** (already reflected in this project's separate `OMIE_MATRIZ_APP_KEY`/`OMIE_FILIAL_APP_KEY` credentials) — so this design needs **two separate webhook registrations**, one per account's Developer Portal, both additive alongside the existing Weesutech webhook in each account.

## Purpose

Get the NCM (per item) and invoice number for each Mercado Livre order's product(s), plus a permanent link to the invoice's XML and DANFE, so the "Margem de contribuição" page can compute ICMS debit and drop the "aguardando XML" state — **primarily by having Omie push this data to us the moment an invoice is authorized**, rather than by polling Omie for it.

## Non-goals

- **Storing the XML/DANFE file ourselves.** Owner's decision this session: store the CDN links Omie already provides (`nfe_xml_url`, `nfe_danfe_url`), not a copy of the file. The file is small (~12KB in the sample seen), so this isn't a storage-cost decision — it's that Omie, as the seller's own ERP and the legal issuer of the note, already has every incentive to keep these links stable for as long as Brazilian tax law requires the note to be retrievable, and downloading/storing our own copy adds storage and access-control complexity for no functional gain over what the parent spec already needed (NCM, invoice number — both get extracted and stored permanently as their own fields regardless of whether we keep the file).
- **Changing what the ICMS/PIS/COFINS credits apply to,** or the matriz/filial rate-table split itself. Both are unchanged from the parent spec (`src/lib/margin/calculateMargin.ts`, already shipped).
- **Reconfiguring the existing Weesutech integration** (its webhook, its field mappings, anything in either Omie account it already touches). This project only *adds* a second, independent webhook per account — it never edits or removes what's already there.
- **A settings UI for the new webhook secret or Omie credentials.** Same pattern as the parent spec: environment variables, server-only, set once.
- **Other marketplaces.** Unchanged — Mercado Livre only.

## Architecture

### Two new webhooks (additive, one per Omie account)

In each Omie account's Developer Portal (Aplicativos → app → "Adicionar novo webhook"), register a new webhook — **without touching the existing Weesutech webhook already there** — subscribed to topic `NFe.NotaAutorizada`, pointed at:

```
https://salfhcosmeticos.tech/api/webhooks/omie?account=matriz&secret=<OMIE_WEBHOOK_SECRET>
https://salfhcosmeticos.tech/api/webhooks/omie?account=filial&secret=<OMIE_WEBHOOK_SECRET>
```

One shared secret (new env var `OMIE_WEBHOOK_SECRET`, same pattern as `ML_WEBHOOK_SECRET`) is enough — the `account` query param (not `empresa_cnpj` from the payload) is what tells the route which Omie account's credentials to use for the follow-up `ConsultarPedido`/`ObterNfe` calls, since that's known with certainty from which URL was registered where, not inferred from payload content.

### New route: `src/app/api/webhooks/omie/route.ts`

Mirrors the existing `src/app/api/webhooks/mercadolivre/route.ts` pattern (checks the `secret` query param before doing anything else; malformed/unauthenticated requests get a fast, cheap rejection). On a valid `NFe.NotaAutorizada` event:

1. Read `event.id_pedido`, `event.id_nf`, `event.empresa_cnpj`, `event.nfe_xml`, `event.nfe_danfe`, `event.numero_nf` from the payload.
2. Call `ConsultarPedido({ codigo_pedido: event.id_pedido })` against the Omie account implied by the `account` query param, to read `informacoes_adicionais.numero_pedido_cliente` — the Mercado Livre order id.
3. Look up the matching `orders` row by `ml_order_id`. If none exists yet (webhook arrived before the order was synced from Mercado Livre — plausible given invoicing can happen fast), record the fact for a later retry (mirrors the existing `retryPendingFiscalDocuments` reconciliation pattern) rather than dropping the event.
4. Fetch the XML from `event.nfe_xml` (a plain HTTPS GET, no Omie auth needed — it's a public-by-link CDN URL) and parse it for NCM per item and the invoice's own product code, matched to `order_items.product_code` the same way the parent spec already does (by seller SKU).
5. Write `orders.nf_number` (from `event.numero_nf`), `orders.nf_fetched_at`, `orders.nfe_xml_url` (`event.nfe_xml`), `orders.nfe_danfe_url` (`event.nfe_danfe`), `orders.cnpj` (`'matriz'` or `'filial'`, from which `account` the webhook came in on — ground truth, not the `logistic_type` heuristic), and `order_items.ncm` per matched item.

### Database changes

New migration, following the style of `0005_logistic_type.sql`:

```sql
alter table public.orders
  add column nfe_xml_url text,
  add column nfe_danfe_url text;
```

`orders.cnpj` is **not** a new column — reuse the existing `orders.logistic_type` for the backfill path (below), but the webhook path knows the CNPJ with certainty from the account query param, so `calculateOrderMargin`'s `cnpj: BillingCnpj` derivation (currently `logistic_type === 'fulfillment' ? 'filial' : 'matriz'` in `page.tsx`) should prefer a directly-known value when the webhook already established one. Simplest approach: **the webhook handler routes to the correct Omie account, and that routing itself is the CNPJ** — no new column needed, `logistic_type` stays as-is (still useful context, e.g. for display), and the margin page's existing derivation from `logistic_type` remains a reasonable fallback for orders whose invoice hasn't arrived via webhook yet.

### XML parsing

A new, small XML parser is needed — conceptually similar to the one deleted in Task 7 (`src/lib/mercadolivre/nfe.ts`), but parsing Omie's XML (fetched from `nfe_xml_url`) instead of a Mercado Livre-sourced one. Reuses the same `fast-xml-parser` approach that file used (removed from `package.json` in Task 7 — re-adding it is in scope here). NCM in Omie's structured API responses came back **dotted** (`"3305.90.00"`) in earlier testing (via `ListarNF`) — the raw XML's `<NCM>` tag should be checked for the same formatting and normalized (strip non-digits) before comparing against `ICMS_EXEMPT_COSMETIC_NCMS` in `calculateMargin.ts`, which expects bare digits (`"33059000"`).

### Backfill for orders invoiced before the webhook existed

For any `orders` row with `nf_fetched_at is null` at the time the webhooks go live (the existing `retryPendingFiscalDocuments` reconciliation job's population), a **one-time** polling pass is still needed, using the two-stage lookup this session mapped out in full against real data:

1. Pick which Omie account to search first using the existing `logistic_type === 'fulfillment' ? 'filial' : 'matriz'` heuristic (same rule already used elsewhere) — this is just a starting guess to reduce work, not authoritative.
2. Search `ListarPedidos` (`produtos/pedido/`), date-windowed around `orders.order_date` (a similar window to the parent spec's original `ListarNF` fallback: order date to +10 days covers typical invoicing lag), **100 records per page** (not 50), matching `informacoes_adicionais.numero_pedido_cliente === ml_order_id` client-side. If exhausted with no match, retry against the other Omie account before giving up for that pass (a Pedido found in one account is unambiguous ground truth for which CNPJ issued it, overriding the initial heuristic guess if they disagree).
3. Once the Pedido is found, take its `cabecalho.codigo_pedido` and search `ListarNF` (`produtos/nfconsultar/`) in the same date window for a note whose `compl.nIdPedido === codigo_pedido`, to get `compl.nIdNF`.
4. Call `ObterNfe({ nIdNfe })` to get `cXmlNfe`/`cPdf`/`cNumNfe`, and proceed exactly like the webhook path from step 4 onward.
5. Rate-limit discipline per the confirmed limits: pace requests to stay well under 240/min per method, and if `ConsultarNF`/`ObterNfe` genuinely fails for a specific id (as opposed to a `ListarPedidos`/`ListarNF` page simply not containing a match), stop and count it as one error for that order rather than retrying the same failing call — avoiding the 10-failures-in-a-row block.

This backfill only needs to run once per historically-pending order — going forward, the webhook covers everything, so this is a bounded, one-time cost, not an ongoing job shape like the original `retryPendingFiscalDocuments` polling design assumed.

### What this replaces in the codebase

- `src/lib/omie/client.ts` (Task 3): the current `lookupInvoice(account, mlOrderId, orderDate)` function assumed a single `ConsultarNF`/`ListarNF` call could resolve the invoice directly — wrong per this session's findings. Needs to become the multi-step `ListarPedidos` → `ListarNF` → `ObterNfe` chain described above (used only by the backfill path), plus a new `ConsultarPedido` function (used by both the webhook path and step 2 of the backfill).
- `src/lib/mercadolivre/sync.ts`'s `upsertOrder`/`retryPendingFiscalDocuments` (Tasks 5/6): the inline NCM-lookup-at-sync-time logic goes away — NCM now arrives via the webhook (or the one-time backfill), not at Mercado Livre sync time. `upsertOrder` no longer needs to call into Omie at all.
- Everything else from the parent spec (the filial ICMS rate table, `BillingCnpj` dispatch, the `orders.logistic_type` column and its capture from `getShipmentAddress`, the margin page wiring) is unchanged and stays as already shipped.

## Error handling

- **Webhook arrives for an order not yet synced from Mercado Livre:** don't drop it — record it (e.g. a small `pending_omie_events` table, or reuse `sync_runs` with a distinguishing `run_type`) and let a lightweight periodic sweep retry the `orders` lookup for a bounded window (mirrors how `retryPendingFiscalDocuments` already handles "not ready yet" states without treating them as errors).
- **`ConsultarPedido` fails for a webhook's `id_pedido`:** genuinely unexpected (Omie just told us this pedido exists) — log as an error, don't silently drop the event; a human should notice if this ever happens.
- **XML fetch from `nfe_xml_url` fails:** retry-worthy (transient network/CDN issue), not a "this order doesn't have an invoice" case — treat like today's Omie-API-failure handling (counted as an error for that order, doesn't block the rest of a batch).
- **Backfill's per-order failures:** unchanged philosophy from the parent spec — isolate per order, log to `sync_runs`, keep processing the rest of the batch.
- **Webhook secret mismatch / malformed payload:** reject fast (400/401), same as the existing Mercado Livre webhook route.

## Testing

- `src/app/api/webhooks/omie/route.ts`: unit tests with a mocked Omie client (`ConsultarPedido` mocked) and mocked `fetch` for the XML download, covering: valid `NFe.NotaAutorizada` payload → correct `orders`/`order_items` writes; unknown `id_pedido` (order not yet synced) → recorded for retry, not dropped; wrong/missing secret → rejected; malformed payload → rejected without throwing.
- New Omie client functions (`ConsultarPedido`, the backfill's `ListarPedidos`/`ListarNF`/`ObterNfe` chain): mocked-`fetch` unit tests per function, plus the exact real field names/shapes confirmed this session as fixtures (not guessed ones, as the superseded spec's tests were).
- New XML parser: unit tests with a real (anonymized) sample XML structure, covering NCM extraction and normalization (dotted → bare digits), matching the rigor of the deleted `nfe.ts`'s test suite (leading-zero preservation, multi-item invoices, malformed-XML error case).
- `calculateMargin.ts`: no changes needed here (NCM format normalization happens before it, not inside it).

## Rollout

1. Add `OMIE_WEBHOOK_SECRET` env var (new, generate a random value — same pattern as `ML_WEBHOOK_SECRET`).
2. Build and ship the migration (`nfe_xml_url`, `nfe_danfe_url` columns), the new webhook route, the `ConsultarPedido` function, and the XML parser.
3. Register the two new webhooks (one per Omie account) in the Developer Portal, pointed at the deployed route — **owner does this manually, following the same "Adicionar novo webhook" flow used to discover this design**, without touching the existing Weesutech webhook in either account.
4. Verify with a real, low-stakes order: confirm the webhook fires, the route writes the expected `orders`/`order_items` fields, and the margin page picks it up.
5. Run the one-time backfill pass (a script or an admin-triggered route, not a cron — it's a single pass, not recurring) against every `orders` row with `nf_fetched_at is null` at that point.
6. Ships the same way as prior work: commits to `main` (not pushed to `origin` until the owner asks), deployed via the existing EasyPanel pipeline. No changes to the read-only marketplace-API constraint — every new Omie call here is a read (`ConsultarPedido`, `ListarPedidos`, `ListarNF`, `ObterNfe`) or a passive webhook receiver; nothing writes to Omie or Mercado Livre.
