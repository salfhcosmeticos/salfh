import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchDashboardOrders } from './fetchOrders'

function fakeSupabase(response: { data: unknown; error: unknown }): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        order: () => Promise.resolve(response),
      }),
    }),
  } as unknown as SupabaseClient
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fetchDashboardOrders', () => {
  it('maps rows and joins item titles with a comma', async () => {
    const supabase = fakeSupabase({
      data: [
        {
          id: '1',
          status: 'paid',
          total_amount: 150.5,
          order_date: '2026-08-04T09:00:00.000Z',
          order_items: [{ title: 'Produto A' }, { title: 'Produto B' }],
        },
      ],
      error: null,
    })

    const result = await fetchDashboardOrders(supabase)

    expect(result).toEqual({
      error: false,
      rows: [
        {
          id: '1',
          status: 'paid',
          totalAmount: 150.5,
          orderDate: '2026-08-04T09:00:00.000Z',
          itemsSummary: 'Produto A, Produto B',
        },
      ],
    })
  })

  it('joins an empty items array into an empty string', async () => {
    const supabase = fakeSupabase({
      data: [{ id: '2', status: 'cancelled', total_amount: 0, order_date: '2026-08-01T00:00:00.000Z', order_items: [] }],
      error: null,
    })

    const result = await fetchDashboardOrders(supabase)

    expect(result.rows[0].itemsSummary).toBe('')
  })

  it('returns an empty list and error: true when the query fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = fakeSupabase({ data: null, error: { message: 'boom' } })

    const result = await fetchDashboardOrders(supabase)

    expect(result).toEqual({ rows: [], error: true })
  })
})
