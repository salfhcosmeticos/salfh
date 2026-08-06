# Integração com a Omie para NCM da nota fiscal — design

**Date:** 2026-08-06
**Status:** approved by owner, ready for spec review
**Supersedes:** the "NF number and NCM (per item)" section of `2026-08-05-margem-contribuicao-design.md`, which assumed Mercado Livre's Fiscal Documents API (`/v2/fiscalDocuments`) could serve the invoice XML. Confirmed against production this session that endpoint does not exist for this app (generic "resource not found"), and the documented replacement (`/packs/{pack_id}/fiscal_documents`) reports no fiscal document attached even for orders whose NF-e is visibly available in Mercado Livre's own seller panel. The NF-e is issued by the owner's ERP (Omie) and apparently linked to the order through an internal Mercado Livre system with no confirmed public API. This spec replaces that data source with a direct integration to Omie, which actually issues the invoice and has a public, documented API.

## Purpose

Get the NCM (and invoice number) for each Mercado Livre order's product(s) so the "Margem de contribuição" page can compute ICMS debit and drop the "aguardando XML" state. The data comes from the invoice (nota fiscal) Omie already issues for every Mercado Livre sale — not from a file, just the specific fields the margin calculation needs (NCM per item; invoice number). No XML file is stored.

## Non-goals

- **Storing the XML or DANFE file.** Confirmed with the owner: only the extracted fields (NCM, invoice number) are needed, not the file itself. This lets the integration use Omie's structured `ConsultarNF`/`ListarNF` responses directly, with no XML download or parsing step.
- **Changing the ICMS/PIS/COFINS calculation.** The owner explicitly wants to keep `calculateMargin.ts`'s own rate table for ICMS debit and the reference-only credit columns, even though Omie's invoice carries its own computed tax values. Those credits apply to Mercado Livre commission and shipping — costs that never appear on the nota fiscal — so the two are not interchangeable. `calculateMargin.ts` is unchanged by this spec.
- **A settings UI for the Omie credentials.** Both Omie accounts' API keys are environment variables, following the same pattern as `SUPABASE_SERVICE_ROLE_KEY` — set once, not editable from the dashboard.
- **Persisting which CNPJ/Omie account an order resolved to.** `logistic_type` is read from data already fetched per order and used in-memory to pick which Omie account to query; it is not stored. If the owner later wants this visible for auditing, that's a small additive change (one nullable column), not a redesign.
- **Other marketplaces.** Unchanged from the parent spec — Mercado Livre only.

## Architecture

### Two Omie accounts, chosen by fulfillment type

The owner operates two CNPJs, each billed from a separate Omie account with its own API credentials:

- CNPJ `16.864.672/0001-85` (matriz) — issues every sale **except** Fulfillment.
- CNPJ `16.864.672/0003-47` (filial) — issues **only** Fulfillment (Mercado Envios Full) sales.

The sync already calls `GET /shipments/{shippingId}` per order (`getShipmentAddress`, for destination city/state). Confirmed against a real order this session that this same response carries a top-level `logistic_type` field (e.g. `"self_service"`, `"fulfillment"`) — so determining which Omie account to query costs no extra Mercado Livre API call. `getShipmentAddress` is extended to also return `logisticType: string | null`, and the sync picks the account:

```ts
const omieAccount = shipment.logisticType === 'fulfillment' ? omieFilial : omieMatriz
```

### Credentials

Four new environment variables, read the same way `SUPABASE_SERVICE_ROLE_KEY` is today (`process.env.X!`, server-only, never sent to the browser):

- `OMIE_MATRIZ_APP_KEY`, `OMIE_MATRIZ_APP_SECRET`
- `OMIE_FILIAL_APP_KEY`, `OMIE_FILIAL_APP_SECRET`

The owner already has both accounts' credentials; retrieving and placing them in `.env.local` (and later, the production environment) is a rollout step, not something this spec or its implementer needs to see the values for.

### Fetching the invoice

New module `src/lib/omie/client.ts`, POSTing JSON to `https://app.omie.com.br/api/v1/produtos/nfconsultar/` with `{ call, app_key, app_secret, param: [...] }` — the standard Omie API request shape. Two calls, tried in order for a given `(omieAccount, mlOrderId, orderDate)`:

1. **`ConsultarNF`** with `param: [{ cCodNFInt: String(mlOrderId) }]` — a direct lookup by integration code. If the marketplace-to-Omie integration that creates these invoices stores the Mercado Livre order number as the invoice's own integration code, this resolves in one call.
2. **Fallback — `ListarNF`** filtered to an emission-date window (`orderDate` to `orderDate + 10 days`, covering typical invoicing lag), then scan each returned note's "Informações Complementares" text for the order number as a substring. Confirmed against a real invoice this session (order `2000017307031470`) that Mercado Livre's order number is printed verbatim in that field, so this is a reliable fallback even if the integration code isn't set.

Whether step 1 alone is sufficient (i.e., whether `cCodNFInt` is actually populated with the ML order number) is unconfirmed — the plan should verify this against a real account early, the same way this session verified Mercado Livre's `seller_sku` field before writing the matching code. If step 1 never matches, step 2 carries the whole feature, so its date-window and text-match logic get full test coverage regardless of what step 1 turns out to do.

From the matched invoice, per line item: extract `NCM` and the item's own product code (`cProd` — the "Código Produto" field, matching `order_items.product_code`, the same seller SKU value used throughout the margin feature). Also extract the invoice number (`nNF`) for `orders.nf_number`.

**Exact field names inside Omie's `nfCadastro`/`det[]` response (nesting, casing) are unconfirmed against a real response** — verify with one real `ConsultarNF` call against production during implementation before writing the parsing code, rather than guessing from scattered documentation. This mirrors how the Mercado Livre `seller_sku` field name was confirmed this session only by inspecting a real API response, after web search first pointed at the wrong field (`seller_custom_field`).

### What this replaces in `sync.ts` / `client.ts`

- Removed: `findFiscalDocumentForOrder`, `downloadFiscalDocumentXml` (Mercado Livre client functions) and `src/lib/mercadolivre/nfe.ts` (the NF-e XML parser) — all built against the Mercado Livre Fiscal Documents API this spec found doesn't work for this account. No longer needed since Omie returns structured data, not an XML file to parse.
- Replaced: the block in `upsertOrder` that builds `ncmByProductCode` from a Mercado Livre-fetched invoice now calls the new Omie lookup instead. The rest of that function — matching `ncmByProductCode[item.sellerSku]`, writing `order_items.product_code`/`ncm` — is unchanged, since it already keys on the seller SKU regardless of where the NCM came from.
- `retryPendingFiscalDocuments` (the reconciliation job that retries orders where `nf_fetched_at is null`) is rewired to call the Omie lookup instead of the Mercado Livre one. Its existing retry/age-window behavior is unchanged.

### Trigger

No new UI. This plugs into the sync pipeline that already runs automatically — the daily backfill, the webhook handler, and the existing "Ressincronizar" button all call `upsertOrder`, so all three pick up Omie lookups for free once wired in.

## Error handling

- **No invoice found (neither `ConsultarNF` nor the `ListarNF` fallback match):** unchanged from today — `nf_fetched_at` stays null, the order shows "aguardando XML" in the table, and the reconciliation job retries it later. Not an error, not logged as one.
- **Omie API failure (network error, auth failure, rate limit):** matches the project's existing philosophy for per-order failures during sync — logged as an error for that order in `sync_runs`, the rest of the batch keeps processing, the order's other fields (already fetched from Mercado Livre) still save.
- **Wrong Omie account queried (a misclassified `logistic_type`):** the lookup simply finds nothing in that account and falls through to the same "no invoice found" state above — it does not throw, and does not try the other account. If this turns out to happen often enough to matter, it will show up as an unexpectedly high rate of "aguardando XML" and can be revisited then.

## Testing

- `src/lib/omie/client.ts`: unit tests with mocked `fetch`, covering: `ConsultarNF` match, `ConsultarNF` miss → `ListarNF` fallback match, both miss (returns null, does not throw), and one HTTP-error case per call (mapped to a thrown error the sync layer catches per-order, matching the existing Mercado Livre client's error convention).
- `sync.ts`: extend the existing NCM-matching tests with the Omie lookup mocked in place of the old Mercado Livre fiscal-document mock — same fixtures (`product_code`/`sellerSku`), just a different source function. Add a case for `logistic_type: 'fulfillment'` routing to the filial account vs. any other value routing to matriz.
- `retryPendingFiscalDocuments`: existing test coverage (retry behavior, age window, partial-batch-failure isolation) re-pointed at the Omie lookup mock instead of the Mercado Livre one; behavior itself is unchanged so no new cases are needed there.

## Rollout

1. Retrieve both Omie accounts' App Key/App Secret and set the four environment variables locally and in production. The owner already has these; no new account setup needed.
2. Before writing the parsing code, make one real `ConsultarNF` call (either account) against a known real invoice and inspect the raw response to confirm field names/nesting — the one open unconfirmed detail in this spec, flagged above.
3. Confirm whether `cCodNFInt` is actually populated with the Mercado Livre order number on real invoices, to know whether the `ListarNF` fallback is the common path or a rare one — informs how much test/tuning attention the fallback's date window deserves.
4. No schema migration needed — this spec reuses `orders.nf_number`, `orders.nf_fetched_at`, and `order_items.ncm`, all added by the prior margin spec.
5. Ships the same way as prior work: commits to `main` (not pushed to `origin` until the owner asks), deployed via the existing EasyPanel pipeline once verified locally. No changes to the read-only marketplace-API constraint — Omie calls added here are reads only (`ConsultarNF`/`ListarNF`), same as every Mercado Livre call in this project.
