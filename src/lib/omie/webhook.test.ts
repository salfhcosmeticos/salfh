import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { handleOmieWebhook, applyInvoiceToOrder } from './webhook'
import * as client from './client'

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

const VALID_PAYLOAD = {
  topic: 'NFe.NotaAutorizada',
  event: {
    id_pedido: 11268650737,
    id_nf: 11268650821,
    empresa_cnpj: '16864672000185',
    numero_nf: '00037493',
    nfe_xml: 'https://cdn.omie.com.br/repository/xml',
    nfe_danfe: 'https://cdn.omie.com.br/repository/pdf',
  },
}

const SAMPLE_XML =
  '<?xml version="1.0"?><nfeProc><NFe><infNFe><ide><nNF>37493</nNF></ide>' +
  '<det nItem="1"><prod><cProd>SF9004</cProd><NCM>33059000</NCM></prod></det></infNFe></NFe></nfeProc>'

function createFakeSupabase() {
  const orderUpdateCalls: unknown[] = []
  const itemUpdateCalls: unknown[] = []
  const pendingUpsertCalls: unknown[] = []
  let orderRow: { id: string } | null = { id: 'order-row-1' }
  let items: { id: string; product_code: string | null }[] = [{ id: 'item-1', product_code: 'SF9004' }]
  let orderUpdateError: { message: string } | null = null
  let pendingUpsertError: { message: string } | null = null

  const supabaseClient = {
    from(table: string) {
      if (table === 'orders') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: orderRow, error: null }) }) }),
          update: (data: unknown) => ({
            eq: async (_col: string, id: string) => {
              orderUpdateCalls.push({ data, id })
              return { error: orderUpdateError }
            },
          }),
        }
      }
      if (table === 'order_items') {
        return {
          select: () => ({ eq: async () => ({ data: items, error: null }) }),
          update: (data: unknown) => ({
            eq: async (_col: string, id: string) => {
              itemUpdateCalls.push({ data, id })
              return { error: null }
            },
          }),
        }
      }
      if (table === 'pending_omie_invoices') {
        return {
          upsert: async (data: unknown, opts: unknown) => {
            pendingUpsertCalls.push({ data, opts })
            return { error: pendingUpsertError }
          },
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
  }

  return {
    client: supabaseClient as unknown as SupabaseClient,
    orderUpdateCalls,
    itemUpdateCalls,
    pendingUpsertCalls,
    setOrderRow: (row: { id: string } | null) => {
      orderRow = row
    },
    setItems: (rows: { id: string; product_code: string | null }[]) => {
      items = rows
    },
    setOrderUpdateError: (error: { message: string } | null) => {
      orderUpdateError = error
    },
    setPendingUpsertError: (error: { message: string } | null) => {
      pendingUpsertError = error
    },
  }
}

describe('handleOmieWebhook', () => {
  it('resolves the order via consultarPedido, downloads and parses the XML, and writes orders/order_items', async () => {
    vi.spyOn(client, 'consultarPedido').mockResolvedValue({ numeroPedidoCliente: '2000017307031470' })
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE_XML }) as unknown as typeof fetch
    const { client: supabase, orderUpdateCalls, itemUpdateCalls } = createFakeSupabase()

    await handleOmieWebhook(supabase, 'matriz', VALID_PAYLOAD)

    expect(client.consultarPedido).toHaveBeenCalledWith('matriz', 11268650737)
    expect(orderUpdateCalls[0]).toMatchObject({
      id: 'order-row-1',
      data: expect.objectContaining({
        nf_number: '00037493',
        nfe_xml_url: 'https://cdn.omie.com.br/repository/xml',
        nfe_danfe_url: 'https://cdn.omie.com.br/repository/pdf',
      }),
    })
    expect(itemUpdateCalls[0]).toMatchObject({ id: 'item-1', data: { ncm: '33059000' } })
  })

  it('ignores a payload for a different topic', async () => {
    const consultarPedidoMock = vi.spyOn(client, 'consultarPedido')
    const { client: supabase } = createFakeSupabase()

    await handleOmieWebhook(supabase, 'matriz', { topic: 'produto.alterado', event: {} })

    expect(consultarPedidoMock).not.toHaveBeenCalled()
  })

  it('ignores a malformed payload without throwing', async () => {
    const { client: supabase } = createFakeSupabase()

    await expect(handleOmieWebhook(supabase, 'matriz', { not: 'valid' })).resolves.toBeUndefined()
    await expect(handleOmieWebhook(supabase, 'matriz', null)).resolves.toBeUndefined()
  })

  it('parks the event in pending_omie_invoices when the order has not been synced from Mercado Livre yet', async () => {
    vi.spyOn(client, 'consultarPedido').mockResolvedValue({ numeroPedidoCliente: '2000017307031470' })
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE_XML }) as unknown as typeof fetch
    const { client: supabase, setOrderRow, pendingUpsertCalls, orderUpdateCalls } = createFakeSupabase()
    setOrderRow(null)

    await handleOmieWebhook(supabase, 'matriz', VALID_PAYLOAD)

    expect(orderUpdateCalls).toHaveLength(0)
    expect(pendingUpsertCalls[0]).toMatchObject({
      opts: { onConflict: 'ml_order_id' },
      data: expect.objectContaining({
        ml_order_id: 2000017307031470,
        nf_number: '00037493',
        ncm_by_product_code: { SF9004: '33059000' },
      }),
    })
  })

  it('does nothing when the Pedido has no numeroPedidoCliente to link to', async () => {
    vi.spyOn(client, 'consultarPedido').mockResolvedValue({ numeroPedidoCliente: null })
    const { client: supabase, orderUpdateCalls, pendingUpsertCalls } = createFakeSupabase()

    await handleOmieWebhook(supabase, 'matriz', VALID_PAYLOAD)

    expect(orderUpdateCalls).toHaveLength(0)
    expect(pendingUpsertCalls).toHaveLength(0)
  })

  it('throws when the XML download fails, so the caller can log it', async () => {
    vi.spyOn(client, 'consultarPedido').mockResolvedValue({ numeroPedidoCliente: '2000017307031470' })
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch
    const { client: supabase } = createFakeSupabase()

    await expect(handleOmieWebhook(supabase, 'matriz', VALID_PAYLOAD)).rejects.toThrow('Failed to download NFe XML: 500')
  })

  it('throws when the orders.update() call fails, rather than resolving silently', async () => {
    vi.spyOn(client, 'consultarPedido').mockResolvedValue({ numeroPedidoCliente: '2000017307031470' })
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE_XML }) as unknown as typeof fetch
    const { client: supabase, setOrderUpdateError } = createFakeSupabase()
    setOrderUpdateError({ message: 'connection reset' })

    await expect(handleOmieWebhook(supabase, 'matriz', VALID_PAYLOAD)).rejects.toThrow('connection reset')
  })

  it('throws when the pending_omie_invoices.upsert() call fails, rather than resolving silently', async () => {
    vi.spyOn(client, 'consultarPedido').mockResolvedValue({ numeroPedidoCliente: '2000017307031470' })
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE_XML }) as unknown as typeof fetch
    const { client: supabase, setOrderRow, setPendingUpsertError } = createFakeSupabase()
    setOrderRow(null)
    setPendingUpsertError({ message: 'unique constraint violation' })

    await expect(handleOmieWebhook(supabase, 'matriz', VALID_PAYLOAD)).rejects.toThrow('unique constraint violation')
  })
})

describe('applyInvoiceToOrder', () => {
  it('leaves an item untouched when its product_code has no NCM in the map', async () => {
    const { client: supabase, setItems, itemUpdateCalls } = createFakeSupabase()
    setItems([{ id: 'item-1', product_code: 'UNKNOWN' }])

    await applyInvoiceToOrder(supabase, 'order-row-1', {
      nfNumber: '123',
      nfeXmlUrl: null,
      nfeDanfeUrl: null,
      ncmByProductCode: { SF9004: '33059000' },
    })

    expect(itemUpdateCalls).toHaveLength(0)
  })
})
