import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
          { item: { id: 'MLB1', title: 'Produto Teste' }, quantity: 2, unit_price: 99.95, sale_fee: 18.5 },
        ],
        shipping: { id: 987654 },
        tags: ['catalog_listing_eligible'],
      }),
    }) as unknown as typeof fetch

    const order = await getOrder('token-123', 123)
    expect(order).toEqual({
      id: 123,
      status: 'paid',
      totalAmount: 199.9,
      currencyId: 'BRL',
      dateCreated: '2026-08-01T10:00:00.000-04:00',
      items: [{ mlItemId: 'MLB1', title: 'Produto Teste', quantity: 2, unitPrice: 99.95, saleFee: 18.5 }],
      shippingId: 987654,
      salesChannel: 'catalog_listing_eligible',
    })
    expect(order.items[0].saleFee).toBe(18.5)
    expect(order.shippingId).toBe(987654)
    expect(order.salesChannel).toBe('catalog_listing_eligible')
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

describe('getShipmentAddress', () => {
  it('extracts the two-letter UF from a "BR-XX" state id', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ receiver_address: { city: { name: 'Curitiba' }, state: { id: 'BR-PR', name: 'Paraná' } } }),
    }) as unknown as typeof fetch

    const address = await getShipmentAddress('token', 987654)

    expect(address).toEqual({ city: 'Curitiba', state: 'PR' })
  })

  it('falls back to state.name when it is already a two-letter code and there is no id', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ receiver_address: { city: { name: 'Curitiba' }, state: { name: 'PR' } } }),
    }) as unknown as typeof fetch

    const address = await getShipmentAddress('token', 987654)

    expect(address).toEqual({ city: 'Curitiba', state: 'PR' })
  })

  it('falls back to the raw state.name when neither a "BR-XX" id nor a two-letter name is present', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ receiver_address: { city: { name: 'Curitiba' }, state: { name: 'Paraná' } } }),
    }) as unknown as typeof fetch

    const address = await getShipmentAddress('token', 987654)

    expect(address).toEqual({ city: 'Curitiba', state: 'Paraná' })
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
