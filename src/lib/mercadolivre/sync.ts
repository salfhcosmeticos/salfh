import type { SupabaseClient } from '@supabase/supabase-js'
import type { MercadoLivreOrder } from './client'
import { getValidAccessToken, searchOrders, getOrder } from './client'

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
  accountId: string,
  userId: string,
  order: MercadoLivreOrder
): Promise<void> {
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

async function syncOrdersInRange(
  supabase: SupabaseClient,
  account: StoredMercadoLivreAccount,
  fromDate: string,
  toDate: string,
  runType: 'backfill' | 'reconciliation'
): Promise<{ processed: number; errors: number }> {
  let processed = 0
  let errors = 0
  let lastError: string | undefined
  let offset = 0
  let total = Infinity

  try {
    const accessToken = await getValidAccessToken(account, await persistRefreshedTokens(supabase, account.id))

    while (offset < total) {
      const page = await searchOrders(accessToken, account.mlUserId, fromDate, toDate, offset)
      total = page.total
      for (const order of page.orders) {
        try {
          await upsertOrder(supabase, account.id, account.userId, order)
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
    // Failures here mean a token refresh or a searchOrders page call itself
    // failed (as opposed to a single order failing to upsert, which is
    // handled above). Treat it the same way: record it and let the run end
    // gracefully with whatever was processed so far, instead of throwing
    // past recordSyncRun and out to the caller.
    errors += 1
    lastError = error instanceof Error ? error.message : String(error)
  }

  await recordSyncRun(supabase, account.id, account.userId, runType, { processed, errors, lastError })
  return { processed, errors }
}

export async function backfillOrders(
  supabase: SupabaseClient,
  account: StoredMercadoLivreAccount,
  monthsBack: number
): Promise<{ processed: number; errors: number }> {
  const toDate = new Date().toISOString()
  const fromDate = new Date(Date.now() - monthsBack * 30 * 24 * 60 * 60 * 1000).toISOString()
  return syncOrdersInRange(supabase, account, fromDate, toDate, 'backfill')
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
  if (payload.topic !== 'orders_v2') {
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
    await upsertOrder(supabase, storedAccount.id, storedAccount.userId, order)
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
