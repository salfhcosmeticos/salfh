import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyPendingOmieInvoices } from './pendingInvoices'

function createFakeSupabase(
  pending: Record<string, unknown>[],
  orderByMlId: Record<string, { id: string }>,
  options: { orderQueryError?: { message: string } | null; deleteError?: { message: string } | null } = {}
) {
  const deletedIds: string[] = []
  const orderUpdateCalls: unknown[] = []
  const itemsUpsertCalls: unknown[] = []
  const orderQueryError = options.orderQueryError ?? null
  const deleteError = options.deleteError ?? null

  const supabaseClient = {
    from(table: string) {
      if (table === 'pending_omie_invoices') {
        return {
          select: async () => ({ data: pending, error: null }),
          delete: () => ({
            eq: async (_col: string, id: string) => {
              deletedIds.push(id)
              return { error: deleteError }
            },
          }),
        }
      }
      if (table === 'orders') {
        return {
          select: () => ({
            eq: (_col: string, mlOrderId: number) => ({
              maybeSingle: async () => ({
                data: orderQueryError ? null : (orderByMlId[String(mlOrderId)] ?? null),
                error: orderQueryError,
              }),
            }),
          }),
          update: (data: unknown) => ({
            eq: async (_col: string, id: string) => {
              orderUpdateCalls.push({ data, id })
              return { error: null }
            },
          }),
        }
      }
      if (table === 'order_items') {
        return {
          select: () => ({ eq: async () => ({ data: [], error: null }) }),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
  }

  return { client: supabaseClient as unknown as SupabaseClient, deletedIds, orderUpdateCalls, itemsUpsertCalls }
}

describe('applyPendingOmieInvoices', () => {
  it('applies and deletes a pending row whose order has since been synced', async () => {
    const pending = [
      {
        id: 'pending-1',
        ml_order_id: 2000017307031470,
        nf_number: '00037493',
        nfe_xml_url: 'https://cdn.omie.com.br/x',
        nfe_danfe_url: 'https://cdn.omie.com.br/p',
        ncm_by_product_code: { SF9004: '33059000' },
      },
    ]
    const { client: supabase, deletedIds, orderUpdateCalls } = createFakeSupabase(pending, {
      '2000017307031470': { id: 'order-row-1' },
    })

    const result = await applyPendingOmieInvoices(supabase)

    expect(result).toEqual({ processed: 1, errors: 0 })
    expect(deletedIds).toEqual(['pending-1'])
    expect(orderUpdateCalls[0]).toMatchObject({ id: 'order-row-1', data: expect.objectContaining({ nf_number: '00037493' }) })
  })

  it('leaves a pending row untouched (not deleted, not an error) when its order still is not synced', async () => {
    const pending = [
      {
        id: 'pending-1',
        ml_order_id: 999,
        nf_number: '1',
        nfe_xml_url: null,
        nfe_danfe_url: null,
        ncm_by_product_code: {},
      },
    ]
    const { client: supabase, deletedIds } = createFakeSupabase(pending, {})

    const result = await applyPendingOmieInvoices(supabase)

    expect(result).toEqual({ processed: 0, errors: 0 })
    expect(deletedIds).toEqual([])
  })

  it('returns processed: 0, errors: 0 when there are no pending rows', async () => {
    const { client: supabase } = createFakeSupabase([], {})

    expect(await applyPendingOmieInvoices(supabase)).toEqual({ processed: 0, errors: 0 })
  })

  it('counts it as an error, not a silent success, when the orders lookup fails', async () => {
    const pending = [
      {
        id: 'pending-1',
        ml_order_id: 2000017307031470,
        nf_number: '00037493',
        nfe_xml_url: null,
        nfe_danfe_url: null,
        ncm_by_product_code: {},
      },
    ]
    const { client: supabase, deletedIds } = createFakeSupabase(
      pending,
      { '2000017307031470': { id: 'order-row-1' } },
      { orderQueryError: { message: 'connection reset' } }
    )

    const result = await applyPendingOmieInvoices(supabase)

    expect(result).toEqual({ processed: 0, errors: 1 })
    expect(deletedIds).toEqual([])
  })

  it('counts it as an error, not a silent success, when the pending_omie_invoices delete fails', async () => {
    const pending = [
      {
        id: 'pending-1',
        ml_order_id: 2000017307031470,
        nf_number: '00037493',
        nfe_xml_url: null,
        nfe_danfe_url: null,
        ncm_by_product_code: {},
      },
    ]
    const { client: supabase, orderUpdateCalls } = createFakeSupabase(
      pending,
      { '2000017307031470': { id: 'order-row-1' } },
      { deleteError: { message: 'unique constraint violation' } }
    )

    const result = await applyPendingOmieInvoices(supabase)

    expect(result).toEqual({ processed: 0, errors: 1 })
    // The invoice was still applied to the order before the delete failed.
    expect(orderUpdateCalls).toHaveLength(1)
  })
})
