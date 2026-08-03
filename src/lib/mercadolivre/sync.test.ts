import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { upsertOrder } from './sync'
import type { MercadoLivreOrder } from './client'

function createFakeSupabase() {
  const orderUpsertCalls: unknown[] = []
  const itemsUpsertCalls: unknown[] = []

  const client = {
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
      throw new Error(`Unexpected table: ${table}`)
    },
  }

  return { client: client as unknown as SupabaseClient, orderUpsertCalls, itemsUpsertCalls }
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
