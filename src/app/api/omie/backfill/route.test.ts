import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const getUser = vi.fn()
const listarPedidos = vi.fn()
const listarNF = vi.fn()
const obterNfe = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({ auth: { getUser } }),
  createServiceClient: () => fakeServiceClient,
}))
vi.mock('@/lib/omie/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/omie/client')>()
  return { ...actual, listarPedidos, listarNF, obterNfe }
})

let pendingOrders: { id: string; ml_order_id: number; order_date: string; logistic_type: string | null }[] = []
const orderUpdateCalls: unknown[] = []

const fakeServiceClient = {
  from(table: string) {
    if (table === 'orders') {
      return {
        select: () => ({ is: async () => ({ data: pendingOrders, error: null }) }),
        update: (data: unknown) => ({
          eq: async (_col: string, id: string) => {
            orderUpdateCalls.push({ data, id })
            return { error: null }
          },
        }),
      }
    }
    if (table === 'order_items') {
      return { select: () => ({ eq: async () => ({ data: [], error: null }) }) }
    }
    throw new Error(`Unexpected table: ${table}`)
  },
} as unknown as SupabaseClient

const { POST } = await import('./route')
const { NextRequest } = await import('next/server')

function backfillRequest() {
  return new NextRequest('https://example.com/api/omie/backfill', { method: 'POST' })
}

describe('POST /api/omie/backfill', () => {
  beforeEach(() => {
    getUser.mockReset()
    listarPedidos.mockReset()
    listarNF.mockReset()
    obterNfe.mockReset()
    pendingOrders = []
    orderUpdateCalls.length = 0
  })

  it('rejects an unauthenticated request', async () => {
    getUser.mockResolvedValue({ data: { user: null } })

    const response = await POST(backfillRequest())

    expect(response.status).toBe(401)
    expect(listarPedidos).not.toHaveBeenCalled()
  })

  it('finds and applies an invoice for a pending order via the two-stage lookup', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    pendingOrders = [{ id: 'order-1', ml_order_id: 2000017307031470, order_date: '2026-07-07T22:21:00.000Z', logistic_type: null }]
    listarPedidos.mockResolvedValue({
      totalPaginas: 1,
      pedidos: [{ codigoPedido: 11248244211, numeroPedidoCliente: '2000017307031470' }],
    })
    listarNF.mockResolvedValue({ totalPaginas: 1, notas: [{ nIdNf: 11248244216, nIdPedido: 11248244211 }] })
    obterNfe.mockResolvedValue({
      invoiceNumber: '00031513',
      chaveNfe: '412...',
      xml:
        '<?xml version="1.0"?><nfeProc><NFe><infNFe><ide><nNF>31513</nNF></ide>' +
        '<det nItem="1"><prod><cProd>SF9004</cProd><NCM>33059000</NCM></prod></det></infNFe></NFe></nfeProc>',
      pdfUrl: 'https://click.omie.com/pdf',
    })

    const response = await POST(backfillRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ processed: 1, errors: 0 })
    expect(listarPedidos).toHaveBeenCalledWith('matriz', 1, expect.any(String), expect.any(String))
    expect(orderUpdateCalls[0]).toMatchObject({
      id: 'order-1',
      data: expect.objectContaining({ nf_number: '00031513', nfe_danfe_url: 'https://click.omie.com/pdf' }),
    })
  })

  it('tries the other Omie account when the first (per logistic_type) has no match', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    pendingOrders = [{ id: 'order-1', ml_order_id: 111, order_date: '2026-07-07T00:00:00.000Z', logistic_type: 'fulfillment' }]
    listarPedidos
      .mockResolvedValueOnce({ totalPaginas: 1, pedidos: [] }) // filial (first, per logistic_type) - no match
      .mockResolvedValueOnce({ totalPaginas: 1, pedidos: [{ codigoPedido: 1, numeroPedidoCliente: '111' }] }) // matriz

    listarNF.mockResolvedValue({ totalPaginas: 1, notas: [{ nIdNf: 5, nIdPedido: 1 }] })
    obterNfe.mockResolvedValue({
      invoiceNumber: '1',
      chaveNfe: '412...',
      xml: '<?xml version="1.0"?><nfeProc><NFe><infNFe><ide><nNF>1</nNF></ide></infNFe></NFe></nfeProc>',
      pdfUrl: 'https://click.omie.com/pdf',
    })

    const response = await POST(backfillRequest())

    await expect(response.json()).resolves.toEqual({ processed: 1, errors: 0 })
    expect(listarPedidos).toHaveBeenNthCalledWith(1, 'filial', 1, expect.any(String), expect.any(String))
    expect(listarPedidos).toHaveBeenNthCalledWith(2, 'matriz', 1, expect.any(String), expect.any(String))
  })

  it('counts an order as neither processed nor an error when no Pedido is found in either account', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    pendingOrders = [{ id: 'order-1', ml_order_id: 999, order_date: '2026-07-07T00:00:00.000Z', logistic_type: null }]
    listarPedidos.mockResolvedValue({ totalPaginas: 1, pedidos: [] })

    const response = await POST(backfillRequest())

    await expect(response.json()).resolves.toEqual({ processed: 0, errors: 0 })
  })

  it('isolates a per-order failure so the rest of the batch still processes', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    pendingOrders = [
      { id: 'order-fail', ml_order_id: 1, order_date: '2026-07-07T00:00:00.000Z', logistic_type: null },
      { id: 'order-ok', ml_order_id: 2, order_date: '2026-07-07T00:00:00.000Z', logistic_type: null },
    ]
    listarPedidos
      .mockRejectedValueOnce(new Error('Omie API error on ListarPedidos: 500'))
      .mockResolvedValueOnce({ totalPaginas: 1, pedidos: [{ codigoPedido: 1, numeroPedidoCliente: '2' }] })
    listarNF.mockResolvedValue({ totalPaginas: 1, notas: [{ nIdNf: 1, nIdPedido: 1 }] })
    obterNfe.mockResolvedValue({
      invoiceNumber: '1',
      chaveNfe: '412...',
      xml: '<?xml version="1.0"?><nfeProc><NFe><infNFe><ide><nNF>1</nNF></ide></infNFe></NFe></nfeProc>',
      pdfUrl: 'https://click.omie.com/pdf',
    })

    const response = await POST(backfillRequest())

    await expect(response.json()).resolves.toEqual({ processed: 1, errors: 1 })
  })
})
