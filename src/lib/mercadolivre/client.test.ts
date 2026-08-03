import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getValidAccessToken, getOrder, searchOrders } from './client'
import * as oauth from './oauth'

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('getValidAccessToken', () => {
  it('returns the current token when it is not expiring soon', async () => {
    const account = {
      id: 'acc-1',
      accessToken: 'valid-token',
      refreshToken: 'refresh-token',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }
    const onRefresh = vi.fn()
    const token = await getValidAccessToken(account, onRefresh)
    expect(token).toBe('valid-token')
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('refreshes the token when it is expiring soon', async () => {
    const account = {
      id: 'acc-1',
      accessToken: 'old-token',
      refreshToken: 'refresh-token',
      tokenExpiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
    }
    vi.spyOn(oauth, 'refreshMercadoLivreToken').mockResolvedValue({
      accessToken: 'new-token',
      refreshToken: 'new-refresh',
      expiresAt: new Date(Date.now() + 21600 * 1000).toISOString(),
      mlUserId: 999,
    })
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    const token = await getValidAccessToken(account, onRefresh)
    expect(token).toBe('new-token')
    expect(onRefresh).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'new-token' }))
  })
})

describe('getOrder', () => {
  it('maps the Mercado Livre order response to MercadoLivreOrder', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 123,
        status: 'paid',
        total_amount: 199.9,
        currency_id: 'BRL',
        date_created: '2026-08-01T10:00:00.000-04:00',
        order_items: [
          { item: { id: 'MLB1', title: 'Produto Teste' }, quantity: 2, unit_price: 99.95 },
        ],
      }),
    }) as unknown as typeof fetch

    const order = await getOrder('token-123', 123)
    expect(order).toEqual({
      id: 123,
      status: 'paid',
      totalAmount: 199.9,
      currencyId: 'BRL',
      dateCreated: '2026-08-01T10:00:00.000-04:00',
      items: [{ mlItemId: 'MLB1', title: 'Produto Teste', quantity: 2, unitPrice: 99.95 }],
    })
  })
})

describe('searchOrders', () => {
  it('maps a search response into orders and total', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            id: 1,
            status: 'paid',
            total_amount: 50,
            currency_id: 'BRL',
            date_created: '2026-08-01T10:00:00.000-04:00',
            order_items: [],
          },
        ],
        paging: { total: 1 },
      }),
    }) as unknown as typeof fetch

    const result = await searchOrders('token-123', 999, '2026-07-01', '2026-08-01', 0)
    expect(result.total).toBe(1)
    expect(result.orders).toHaveLength(1)
    expect(result.orders[0].id).toBe(1)
  })
})

describe('getOrder rate limiting', () => {
  it('retries after an HTTP 429 and eventually succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 123,
          status: 'paid',
          total_amount: 100,
          currency_id: 'BRL',
          date_created: '2026-08-01T10:00:00.000-04:00',
          order_items: [],
        }),
      })
    global.fetch = fetchMock as unknown as typeof fetch

    const orderPromise = getOrder('token-123', 123)
    await vi.advanceTimersByTimeAsync(1000)
    const order = await orderPromise

    expect(order.id).toBe(123)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
