import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  upsertOrder,
  backfillOrders,
  buildMonthlyWindows,
  handleMercadoLivreWebhook,
  reconcileRecentOrders,
  retryPendingFiscalDocuments,
} from './sync'
import type { MercadoLivreOrder } from './client'
import * as client from './client'
import * as omieClient from '../omie/client'

function createFakeSupabase() {
  const orderUpsertCalls: unknown[] = []
  const itemsUpsertCalls: unknown[] = []
  const syncRunInserts: unknown[] = []

  const supabaseClient = {
    from(table: string) {
      if (table === 'orders') {
        return {
          upsert: (data: unknown, opts: unknown) => {
            orderUpsertCalls.push({ data, opts })
            return { select: () => ({ single: async () => ({ data: { id: 'order-row-1' }, error: null }) }) }
          },
        }
      }
      if (table === 'order_items') {
        return {
          upsert: async (data: unknown, opts: unknown) => {
            itemsUpsertCalls.push({ data, opts })
            return { error: null }
          },
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
  }

  return { client: supabaseClient as unknown as SupabaseClient, orderUpsertCalls, itemsUpsertCalls, syncRunInserts }
}

function createFakeSupabaseWithAccount() {
  const base = createFakeSupabase()
  const originalFrom = base.client.from.bind(base.client)
  base.client.from = ((table: string) => {
    if (table === 'marketplace_accounts') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: 'account-1',
                  user_id: 'user-1',
                  ml_user_id: 999,
                  access_token: 'token-abc',
                  refresh_token: 'refresh-abc',
                  token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                },
                error: null,
              }),
            }),
          }),
        }),
      }
    }
    return originalFrom(table)
  }) as typeof base.client.from
  return base
}

const sampleOrder: MercadoLivreOrder = {
  id: 555,
  status: 'paid',
  totalAmount: 150,
  currencyId: 'BRL',
  dateCreated: '2026-08-01T10:00:00.000-04:00',
  items: [{ mlItemId: 'MLB1', title: 'Produto', quantity: 1, unitPrice: 150, saleFee: 0, sellerSku: null }],
  shippingId: null,
  salesChannel: null,
}

beforeEach(() => {
  vi.spyOn(client, 'getBillingInfo').mockResolvedValue({ buyerName: null })
  vi.spyOn(omieClient, 'lookupInvoice').mockResolvedValue(null)
})

describe('upsertOrder', () => {
  it('upserts the order row keyed by account_id + ml_order_id', async () => {
    const { client, orderUpsertCalls } = createFakeSupabase()
    await upsertOrder(client, 'token-abc', 'account-1', 'user-1', sampleOrder)
    expect(orderUpsertCalls).toHaveLength(1)
    expect(orderUpsertCalls[0]).toMatchObject({
      opts: { onConflict: 'account_id,ml_order_id' },
      data: expect.objectContaining({ account_id: 'account-1', user_id: 'user-1', ml_order_id: 555 }),
    })
  })

  it('upserts order items keyed by order_id + ml_item_id', async () => {
    const { client, itemsUpsertCalls } = createFakeSupabase()
    await upsertOrder(client, 'token-abc', 'account-1', 'user-1', sampleOrder)
    expect(itemsUpsertCalls).toHaveLength(1)
    expect(itemsUpsertCalls[0]).toMatchObject({
      opts: { onConflict: 'order_id,ml_item_id' },
      data: [expect.objectContaining({ order_id: 'order-row-1', user_id: 'user-1', ml_item_id: 'MLB1' })],
    })
  })
})

describe('upsertOrder - margin data', () => {
  it('stores commission as the sum of each item sale_fee', async () => {
    const { client: supabase, orderUpsertCalls } = createFakeSupabase()
    const order: MercadoLivreOrder = {
      ...sampleOrder,
      items: [
        { mlItemId: 'MLB1', title: 'Produto 1', quantity: 1, unitPrice: 169.9, saleFee: 30, sellerSku: 'SF9004' },
        { mlItemId: 'MLB2', title: 'Produto 2', quantity: 1, unitPrice: 67, saleFee: 11.66, sellerSku: 'SF9846' },
      ],
    }

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', order)

    expect(orderUpsertCalls[0]).toMatchObject({ data: expect.objectContaining({ ml_commission: 41.66 }) })
  })

  it('uses shipping_or_fee_type "frete" and the seller shipment cost when sale amount is >= 79', async () => {
    const { client: supabase, orderUpsertCalls } = createFakeSupabase()
    vi.spyOn(client, 'getShipmentAddress').mockResolvedValue({ city: 'Curitiba', state: 'PR', logisticType: null })
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
    vi.spyOn(client, 'getShipmentAddress').mockResolvedValue({ city: 'Curitiba', state: 'PR', logisticType: null })
    const getShipmentSellerCostMock = vi.spyOn(client, 'getShipmentSellerCost')
    const order: MercadoLivreOrder = { ...sampleOrder, totalAmount: 50, shippingId: 987654 }

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', order)

    expect(getShipmentSellerCostMock).not.toHaveBeenCalled()
    expect(orderUpsertCalls[0]).toMatchObject({
      data: expect.objectContaining({ shipping_or_fee_type: 'taxa_fixa', shipping_or_fee_amount: 0 }),
    })
  })

  it('leaves nf_number and nf_fetched_at null and does not throw when no invoice is found', async () => {
    const { client: supabase, orderUpsertCalls } = createFakeSupabase()
    vi.spyOn(omieClient, 'lookupInvoice').mockResolvedValue(null)

    await upsertOrder(supabase, 'token-abc', 'account-1', 'user-1', sampleOrder)

    expect(orderUpsertCalls[0]).toMatchObject({ data: expect.objectContaining({ nf_number: null, nf_fetched_at: null }) })
  })

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
})

describe('buildMonthlyWindows', () => {
  it('produces one window per month, oldest first', () => {
    const windows = buildMonthlyWindows(12, new Date('2026-08-04T12:00:00.000Z'))
    expect(windows).toHaveLength(12)
    expect(windows[0].fromDate).toBe(new Date('2025-08-04T12:00:00.000Z').toISOString())
    expect(windows[11].toDate).toBe(new Date('2026-08-04T12:00:00.000Z').toISOString())
  })

  it('tiles the range with no gaps between consecutive windows', () => {
    const windows = buildMonthlyWindows(12, new Date('2026-08-31T12:00:00.000Z'))
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i].fromDate).toBe(windows[i - 1].toDate)
    }
  })
})

describe('backfillOrders', () => {
  const account = {
    id: 'account-1',
    userId: 'user-1',
    mlUserId: 999,
    accessToken: 'token-abc',
    refreshToken: 'refresh-abc',
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }

  it('pages through search results and upserts every order', async () => {
    const { client: supabase, orderUpsertCalls } = createFakeSupabase()

    vi.spyOn(client, 'getValidAccessToken').mockResolvedValue('token-abc')
    const searchOrdersMock = vi.spyOn(client, 'searchOrders')
    searchOrdersMock.mockResolvedValue({ orders: [], total: 0 })
    searchOrdersMock.mockResolvedValueOnce({ orders: [sampleOrder], total: 2 })
    searchOrdersMock.mockResolvedValueOnce({ orders: [{ ...sampleOrder, id: 556 }], total: 2 })

    const result = await backfillOrders(supabase, account, 12)

    expect(result.processed).toBe(2)
    expect(result.errors).toBe(0)
    expect(orderUpsertCalls).toHaveLength(2)
  })

  it('splits a 12-month backfill into 12 windows and records a single sync_runs row', async () => {
    const { client: supabase, syncRunInserts } = createFakeSupabase()

    vi.spyOn(client, 'getValidAccessToken').mockResolvedValue('token-abc')
    const searchOrdersMock = vi.spyOn(client, 'searchOrders')
    searchOrdersMock.mockResolvedValue({ orders: [], total: 0 })

    await backfillOrders(supabase, account, 12)

    // One search per month window (each window's first page is empty, so the
    // pagination loop stops immediately) — not one continuous offset walk.
    expect(searchOrdersMock).toHaveBeenCalledTimes(12)
    expect(syncRunInserts).toHaveLength(1)

    // Every call starts a fresh offset walk at 0, which is the whole point:
    // no single window can approach Mercado Livre's search offset ceiling.
    for (const call of searchOrdersMock.mock.calls) {
      expect(call[4]).toBe(0)
    }
  })

  it('keeps syncing the remaining months when one window fails', async () => {
    const { client: supabase, orderUpsertCalls, syncRunInserts } = createFakeSupabase()

    vi.spyOn(client, 'getValidAccessToken').mockResolvedValue('token-abc')
    const searchOrdersMock = vi.spyOn(client, 'searchOrders')
    searchOrdersMock.mockResolvedValue({ orders: [], total: 0 })
    // First month blows up; the eleven that follow must still be attempted.
    searchOrdersMock.mockRejectedValueOnce(new Error('ML API unavailable'))
    searchOrdersMock.mockResolvedValueOnce({ orders: [sampleOrder], total: 1 })

    const result = await backfillOrders(supabase, account, 12)

    expect(searchOrdersMock).toHaveBeenCalledTimes(12)
    expect(result).toEqual({ processed: 1, errors: 1 })
    expect(orderUpsertCalls).toHaveLength(1)
    expect(syncRunInserts).toHaveLength(1)
    expect(syncRunInserts[0]).toMatchObject({
      account_id: 'account-1',
      user_id: 'user-1',
      run_type: 'backfill',
      orders_processed: 1,
      error_count: 1,
      last_error: 'ML API unavailable',
    })
  })

  it('does not throw and still records a sync_runs row when searchOrders fails partway through', async () => {
    const { client: supabase, orderUpsertCalls, syncRunInserts } = createFakeSupabase()

    vi.spyOn(client, 'getValidAccessToken').mockResolvedValue('token-abc')
    const searchOrdersMock = vi.spyOn(client, 'searchOrders')
    searchOrdersMock.mockResolvedValue({ orders: [], total: 0 })
    searchOrdersMock.mockResolvedValueOnce({ orders: [sampleOrder], total: 2 })
    searchOrdersMock.mockRejectedValueOnce(new Error('ML API unavailable'))

    const result = await backfillOrders(supabase, account, 12)

    expect(result).toEqual({ processed: 1, errors: 1 })
    expect(orderUpsertCalls).toHaveLength(1)
    expect(syncRunInserts).toHaveLength(1)
    expect(syncRunInserts[0]).toMatchObject({
      account_id: 'account-1',
      user_id: 'user-1',
      run_type: 'backfill',
      orders_processed: 1,
      error_count: 1,
      last_error: 'ML API unavailable',
    })
  })

  it('does not throw and still records a sync_runs row when getValidAccessToken fails', async () => {
    const { client: supabase, syncRunInserts } = createFakeSupabase()

    vi.spyOn(client, 'getValidAccessToken').mockRejectedValue(new Error('token refresh failed'))
    const searchOrdersMock = vi.spyOn(client, 'searchOrders')

    const result = await backfillOrders(supabase, account, 12)

    // The token is acquired once for the whole backfill, so a refresh failure
    // is a single error — not one per month window.
    expect(result).toEqual({ processed: 0, errors: 1 })
    expect(searchOrdersMock).not.toHaveBeenCalled()
    expect(syncRunInserts).toHaveLength(1)
    expect(syncRunInserts[0]).toMatchObject({
      error_count: 1,
      orders_processed: 0,
      last_error: 'token refresh failed',
    })
  })

  it('logs to the console when a run finishes with errors', async () => {
    const { client: supabase } = createFakeSupabase()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.spyOn(client, 'getValidAccessToken').mockRejectedValue(new Error('token refresh failed'))

    await backfillOrders(supabase, account, 12)

    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(String(consoleError.mock.calls[0][0])).toContain('token refresh failed')
    consoleError.mockRestore()
  })

  it('does not log when a run finishes cleanly', async () => {
    const { client: supabase } = createFakeSupabase()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.spyOn(client, 'getValidAccessToken').mockResolvedValue('token-abc')
    vi.spyOn(client, 'searchOrders').mockResolvedValue({ orders: [], total: 0 })

    await backfillOrders(supabase, account, 12)

    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})

describe('handleMercadoLivreWebhook', () => {
  it('ignores topics other than orders_v2', async () => {
    const { client: supabase } = createFakeSupabase()
    await expect(
      handleMercadoLivreWebhook(supabase, { topic: 'messages', resource: '/orders/1', user_id: 999 })
    ).resolves.toBeUndefined()
  })

  it('does not throw when resource is malformed (missing/null) on an orders_v2 payload', async () => {
    const { client: supabase } = createFakeSupabase()

    await expect(
      handleMercadoLivreWebhook(
        supabase,
        { topic: 'orders_v2', resource: null, user_id: 999 } as unknown as {
          topic: string
          resource: string
          user_id: number
        }
      )
    ).resolves.toBeUndefined()

    await expect(
      handleMercadoLivreWebhook(
        supabase,
        { topic: 'orders_v2', user_id: 999 } as unknown as { topic: string; resource: string; user_id: number }
      )
    ).resolves.toBeUndefined()
  })

  it('fetches and upserts the order for orders_v2 events', async () => {
    const { client: supabase, orderUpsertCalls } = createFakeSupabaseWithAccount()
    vi.spyOn(client, 'getValidAccessToken').mockResolvedValue('token-abc')
    vi.spyOn(client, 'getOrder').mockResolvedValue(sampleOrder)

    await handleMercadoLivreWebhook(supabase, {
      topic: 'orders_v2',
      resource: '/orders/555',
      user_id: 999,
    })

    expect(orderUpsertCalls).toHaveLength(1)
  })

  it('does not throw and still records a failed sync_runs row when getOrder fails', async () => {
    const { client: supabase, orderUpsertCalls, syncRunInserts } = createFakeSupabaseWithAccount()
    vi.spyOn(client, 'getValidAccessToken').mockResolvedValue('token-abc')
    vi.spyOn(client, 'getOrder').mockRejectedValue(new Error('ML API unavailable'))

    await expect(
      handleMercadoLivreWebhook(supabase, { topic: 'orders_v2', resource: '/orders/555', user_id: 999 })
    ).resolves.toBeUndefined()

    expect(orderUpsertCalls).toHaveLength(0)
    expect(syncRunInserts).toHaveLength(1)
    expect(syncRunInserts[0]).toMatchObject({
      account_id: 'account-1',
      user_id: 'user-1',
      run_type: 'webhook',
      orders_processed: 0,
      error_count: 1,
      last_error: 'ML API unavailable',
    })
  })

  it('does not throw and still records a failed sync_runs row when getValidAccessToken fails', async () => {
    const { client: supabase, syncRunInserts } = createFakeSupabaseWithAccount()
    vi.spyOn(client, 'getValidAccessToken').mockRejectedValue(new Error('token refresh failed'))
    const getOrderMock = vi.spyOn(client, 'getOrder')

    await expect(
      handleMercadoLivreWebhook(supabase, { topic: 'orders_v2', resource: '/orders/555', user_id: 999 })
    ).resolves.toBeUndefined()

    expect(getOrderMock).not.toHaveBeenCalled()
    expect(syncRunInserts).toHaveLength(1)
    expect(syncRunInserts[0]).toMatchObject({
      run_type: 'webhook',
      orders_processed: 0,
      error_count: 1,
      last_error: 'token refresh failed',
    })
  })
})

describe('reconcileRecentOrders', () => {
  it('searches only the recent time window and upserts results', async () => {
    const { client: supabase, orderUpsertCalls } = createFakeSupabase()
    vi.spyOn(client, 'getValidAccessToken').mockResolvedValue('token-abc')
    const searchOrdersMock = vi.spyOn(client, 'searchOrders')
    searchOrdersMock.mockResolvedValueOnce({ orders: [sampleOrder], total: 1 })

    const account = {
      id: 'account-1',
      userId: 'user-1',
      mlUserId: 999,
      accessToken: 'token-abc',
      refreshToken: 'refresh-abc',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }

    const result = await reconcileRecentOrders(supabase, account, 2)
    expect(result.processed).toBe(1)
    expect(orderUpsertCalls).toHaveLength(1)
  })
})

describe('retryPendingFiscalDocuments', () => {
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

  it('filters pending orders by account_id and nf_fetched_at is null', async () => {
    const selectCalls: { eqArgs: unknown[]; isArgs: unknown[] }[] = []
    const supabase = {
      from(table: string) {
        if (table === 'orders') {
          return {
            select: () => ({
              eq: (...eqArgs: unknown[]) => ({
                is: async (...isArgs: unknown[]) => {
                  selectCalls.push({ eqArgs, isArgs })
                  return { data: [], error: null }
                },
              }),
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

    await retryPendingFiscalDocuments(supabase, account)

    expect(selectCalls).toHaveLength(1)
    expect(selectCalls[0].eqArgs).toEqual(['account_id', 'account-1'])
    expect(selectCalls[0].isArgs).toEqual(['nf_fetched_at', null])
  })

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
})
