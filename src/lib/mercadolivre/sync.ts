import type { SupabaseClient } from '@supabase/supabase-js'
import { subMonths } from 'date-fns'
import type { MercadoLivreOrder } from './client'
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

const FREE_SHIPPING_THRESHOLD = 79

export interface StoredMercadoLivreAccount {
  id: string
  userId: string
  mlUserId: number
  accessToken: string
  refreshToken: string
  tokenExpiresAt: string
}

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

  let buyerName: string | null = null
  try {
    buyerName = (await getBillingInfo(accessToken, order.id)).buyerName
  } catch {
    // Buyer billing info can be genuinely unavailable; never block the sync on it.
  }

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
        logistic_type: logisticType,
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
    product_code: item.sellerSku,
    ncm: item.sellerSku ? (ncmByProductCode[item.sellerSku] ?? null) : null,
  }))

  const { error: itemsError } = await supabase
    .from('order_items')
    .upsert(itemRows, { onConflict: 'order_id,ml_item_id' })

  if (itemsError) {
    throw new Error(`Falha ao gravar itens do pedido ${order.id}: ${itemsError.message}`)
  }
}

async function recordSyncRun(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  runType: 'backfill' | 'reconciliation' | 'webhook',
  result: { processed: number; errors: number; lastError?: string }
): Promise<void> {
  // Nothing in the UI reads sync_runs yet, so a failed run would otherwise be
  // invisible unless someone thought to open the Supabase table editor. Logging
  // here — the single point every run type funnels through — puts failures in
  // the application logs (EasyPanel) where they can actually be noticed.
  if (result.errors > 0) {
    console.error(
      `Mercado Livre ${runType} run finished with ${result.errors} error(s) ` +
        `(${result.processed} processed) for account ${accountId}. Last error: ${result.lastError ?? 'unknown'}`
    )
  }

  await supabase.from('sync_runs').insert({
    account_id: accountId,
    user_id: userId,
    run_type: runType,
    finished_at: new Date().toISOString(),
    orders_processed: result.processed,
    error_count: result.errors,
    last_error: result.lastError ?? null,
  })
}

async function persistRefreshedTokens(
  supabase: SupabaseClient,
  accountId: string
) {
  return async (tokens: { accessToken: string; refreshToken: string; expiresAt: string }) => {
    await supabase
      .from('marketplace_accounts')
      .update({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_expires_at: tokens.expiresAt,
      })
      .eq('id', accountId)
  }
}

interface SyncWindowResult {
  processed: number
  errors: number
  lastError?: string
}

/**
 * Pages through one [fromDate, toDate) window and upserts every order found.
 * Never throws: a page-level failure (e.g. Mercado Livre's offset ceiling on
 * /orders/search) is recorded and returned so the caller can keep going with
 * the remaining windows.
 */
async function syncOrdersWindow(
  supabase: SupabaseClient,
  account: StoredMercadoLivreAccount,
  accessToken: string,
  fromDate: string,
  toDate: string
): Promise<SyncWindowResult> {
  let processed = 0
  let errors = 0
  let lastError: string | undefined
  let offset = 0
  let total = Infinity

  try {
    while (offset < total) {
      const page = await searchOrders(accessToken, account.mlUserId, fromDate, toDate, offset)
      total = page.total
      for (const order of page.orders) {
        try {
          await upsertOrder(supabase, accessToken, account.id, account.userId, order)
          processed += 1
        } catch (error) {
          errors += 1
          lastError = error instanceof Error ? error.message : String(error)
        }
      }
      if (page.orders.length === 0) break
      offset += page.orders.length
    }
  } catch (error) {
    // A searchOrders page call itself failed (as opposed to a single order
    // failing to upsert, which is handled above). Record it and let the window
    // end gracefully with whatever was processed so far.
    errors += 1
    lastError = error instanceof Error ? error.message : String(error)
  }

  return { processed, errors, lastError }
}

export async function syncOrdersInRange(
  supabase: SupabaseClient,
  account: StoredMercadoLivreAccount,
  fromDate: string,
  toDate: string,
  runType: 'backfill' | 'reconciliation'
): Promise<{ processed: number; errors: number }> {
  let processed = 0
  let errors = 0
  let lastError: string | undefined

  try {
    const accessToken = await getValidAccessToken(account, await persistRefreshedTokens(supabase, account.id))
    const window = await syncOrdersWindow(supabase, account, accessToken, fromDate, toDate)
    processed = window.processed
    errors = window.errors
    lastError = window.lastError
  } catch (error) {
    // Token refresh failed, so no window could even be attempted.
    errors += 1
    lastError = error instanceof Error ? error.message : String(error)
  }

  await recordSyncRun(supabase, account.id, account.userId, runType, { processed, errors, lastError })
  return { processed, errors }
}

/**
 * Splits the backfill range into contiguous one-month windows, oldest first.
 * Window N's end is computed with the exact same expression as window N+1's
 * start, so the windows tile the range with no gaps.
 */
export function buildMonthlyWindows(
  monthsBack: number,
  now: Date = new Date()
): { fromDate: string; toDate: string }[] {
  const windows: { fromDate: string; toDate: string }[] = []
  for (let i = monthsBack; i >= 1; i -= 1) {
    windows.push({
      fromDate: subMonths(now, i).toISOString(),
      toDate: subMonths(now, i - 1).toISOString(),
    })
  }
  return windows
}

export async function backfillOrders(
  supabase: SupabaseClient,
  account: StoredMercadoLivreAccount,
  monthsBack: number
): Promise<{ processed: number; errors: number }> {
  let processed = 0
  let errors = 0
  let lastError: string | undefined

  try {
    const accessToken = await getValidAccessToken(account, await persistRefreshedTokens(supabase, account.id))

    // One search window per month instead of a single continuous offset walk
    // across the whole year: Mercado Livre's /orders/search has an offset
    // ceiling, and a high-volume seller could hit it mid-backfill, silently
    // truncating the history. Per-month chunks keep each offset walk small,
    // and a window that does fail no longer costs us the other 11 months.
    for (const window of buildMonthlyWindows(monthsBack)) {
      const result = await syncOrdersWindow(supabase, account, accessToken, window.fromDate, window.toDate)
      processed += result.processed
      errors += result.errors
      if (result.lastError) lastError = result.lastError
    }
  } catch (error) {
    // Token refresh failed, so no window could even be attempted.
    errors += 1
    lastError = error instanceof Error ? error.message : String(error)
  }

  // One sync_runs row for the whole backfill, not one per month.
  await recordSyncRun(supabase, account.id, account.userId, 'backfill', { processed, errors, lastError })
  return { processed, errors }
}

export async function reconcileRecentOrders(
  supabase: SupabaseClient,
  account: StoredMercadoLivreAccount,
  hoursBack: number
): Promise<{ processed: number; errors: number }> {
  const toDate = new Date().toISOString()
  const fromDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString()
  return syncOrdersInRange(supabase, account, fromDate, toDate, 'reconciliation')
}

export interface MercadoLivreWebhookPayload {
  topic: string
  resource: string
  user_id: number
}

export async function handleMercadoLivreWebhook(
  supabase: SupabaseClient,
  payload: MercadoLivreWebhookPayload
): Promise<void> {
  if (typeof payload?.topic !== 'string' || payload.topic !== 'orders_v2') {
    return
  }

  // The payload is untrusted external input (no signature verification in
  // this plan), so `resource` may be missing, null, or non-string. Bail out
  // before parsing rather than letting `.split()` throw a TypeError that
  // would propagate uncaught through the webhook route as a 500 — the same
  // retry-storm outcome this task's graceful-degradation fix exists to avoid.
  if (typeof payload.resource !== 'string') {
    return
  }

  const orderId = Number(payload.resource.split('/').pop())

  const { data: account, error } = await supabase
    .from('marketplace_accounts')
    .select('*')
    .eq('ml_user_id', payload.user_id)
    .eq('marketplace', 'mercado_livre')
    .maybeSingle()

  if (error || !account) {
    return
  }

  const storedAccount: StoredMercadoLivreAccount = {
    id: account.id,
    userId: account.user_id,
    mlUserId: account.ml_user_id,
    accessToken: account.access_token,
    refreshToken: account.refresh_token,
    tokenExpiresAt: account.token_expires_at,
  }

  // A transient failure here (token refresh or the ML API call) must not
  // throw past this point: the caller is the webhook route, and Mercado
  // Livre retries deliveries on non-2xx responses. We record the failure in
  // sync_runs and let the route respond normally, same as the fix applied
  // to syncOrdersInRange for backfill/reconciliation.
  let processed = 0
  let errors = 0
  let lastError: string | undefined

  try {
    const accessToken = await getValidAccessToken(
      storedAccount,
      await persistRefreshedTokens(supabase, storedAccount.id)
    )
    const order = await getOrder(accessToken, orderId)
    await upsertOrder(supabase, accessToken, storedAccount.id, storedAccount.userId, order)
    processed = 1
  } catch (err) {
    errors = 1
    lastError = err instanceof Error ? err.message : String(err)
  }

  await recordSyncRun(supabase, storedAccount.id, storedAccount.userId, 'webhook', {
    processed,
    errors,
    lastError,
  })
}

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
        const ncmByProductCode = Object.fromEntries(invoice.items.map((item) => [item.productCode, item.ncm]))

        const { error: orderUpdateError } = await supabase
          .from('orders')
          .update({ nf_number: invoice.invoiceNumber, nf_fetched_at: new Date().toISOString() })
          .eq('id', pendingOrder.id)

        if (orderUpdateError) {
          throw new Error(orderUpdateError.message)
        }

        const { data: items, error: itemsQueryError } = await supabase
          .from('order_items')
          .select('id, product_code')
          .eq('order_id', pendingOrder.id)

        if (itemsQueryError) {
          throw new Error(itemsQueryError.message)
        }

        // NCM is matched by product_code (the seller's own SKU, captured at
        // sync time from Mercado Livre's order data) - the same code the
        // invoice prints as "CÓDIGO PRODUTO", so this is a direct, reliable
        // lookup rather than a positional guess.
        for (const item of items ?? []) {
          const ncm = item.product_code ? ncmByProductCode[item.product_code] : undefined
          if (ncm) {
            const { error: itemUpdateError } = await supabase.from('order_items').update({ ncm }).eq('id', item.id)
            if (itemUpdateError) {
              throw new Error(itemUpdateError.message)
            }
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
