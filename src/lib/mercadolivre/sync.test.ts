import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  upsertOrder,
  backfillOrders,
  buildMonthlyWindows,
  handleMercadoLivreWebhook,
  reconcileRecentOrders,
} from './sync'
import type { MercadoLivreOrder } from './client'
import * as client from './client'

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
  items: [{ mlItemId: 'MLB1', title: 'Produto', quantity: 1, unitPrice: 150 }],
}

describe('upsertOrder', () => {
  it('upserts the order row keyed by account_id + ml_order_id', async () => {
    const { client, orderUpsertCalls } = createFakeSupabase()
    await upsertOrder(client, 'account-1', 'user-1', sampleOrder)
    expect(orderUpsertCalls).toHaveLength(1)
    expect(orderUpsertCalls[0]).toMatchObject({
      opts: { onConflict: 'account_id,ml_order_id' },
      data: expect.objectContaining({ account_id: 'account-1', user_id: 'user-1', ml_order_id: 555 }),
    })
  })

  it('upserts order items keyed by order_id + ml_item_id', async () => {
    const { client, itemsUpsertCalls } = createFakeSupabase()
    await upsertOrder(client, 'account-1', 'user-1', sampleOrder)
    expect(itemsUpsertCalls).toHaveLength(1)
    expect(itemsUpsertCalls[0]).toMatchObject({
      opts: { onConflict: 'order_id,ml_item_id' },
      data: [expect.objectContaining({ order_id: 'order-row-1', user_id: 'user-1', ml_item_id: 'MLB1' })],
    })
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
