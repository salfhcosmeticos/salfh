import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { lookupInvoice } from './client'

const originalFetch = global.fetch
const originalEnv = { ...process.env }

beforeEach(() => {
  process.env.OMIE_MATRIZ_APP_KEY = 'matriz-key'
  process.env.OMIE_MATRIZ_APP_SECRET = 'matriz-secret'
  process.env.OMIE_FILIAL_APP_KEY = 'filial-key'
  process.env.OMIE_FILIAL_APP_SECRET = 'filial-secret'
})

afterEach(() => {
  global.fetch = originalFetch
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
})

describe('lookupInvoice', () => {
  it('returns the invoice from ConsultarNF when the integration code matches directly', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        nfCadastro: {
          compl: { nNF: '123456' },
          det: [{ produto: { cProd: 'SF9004', NCM: '33059000' } }],
        },
      }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const invoice = await lookupInvoice('matriz', 2000017307031470, new Date('2026-08-01T00:00:00.000Z'))

    expect(invoice).toEqual({ invoiceNumber: '123456', items: [{ productCode: 'SF9004', ncm: '33059000' }] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({
      call: 'ConsultarNF',
      app_key: 'matriz-key',
      app_secret: 'matriz-secret',
      param: [{ cCodNFInt: '2000017307031470' }],
    })
  })

  it('falls back to ListarNF and matches by order number inside "Informações Complementares" when ConsultarNF misses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ faultstring: 'NF nao encontrada' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          nfCadastro: [
            {
              compl: { nNF: '999' },
              det: [{ produto: { cProd: 'SF9846', NCM: '33051000' } }],
              informacoesAdicionais: { obsAdicFisco: 'Pedido Mercado Livre 2000017307031470' },
            },
          ],
        }),
      })
    global.fetch = fetchMock as unknown as typeof fetch

    const invoice = await lookupInvoice('filial', 2000017307031470, new Date('2026-08-01T00:00:00.000Z'))

    expect(invoice).toEqual({ invoiceNumber: '999', items: [{ productCode: 'SF9846', ncm: '33051000' }] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const listBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(listBody).toMatchObject({
      call: 'ListarNF',
      app_key: 'filial-key',
      app_secret: 'filial-secret',
      param: [{ nDataEmiInicial: '01/08/2026', nDataEmiFinal: '11/08/2026' }],
    })
  })

  it('returns null when both ConsultarNF and the ListarNF fallback miss', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ faultstring: 'NF nao encontrada' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ nfCadastro: [] }) })
    global.fetch = fetchMock as unknown as typeof fetch

    const invoice = await lookupInvoice('matriz', 111, new Date('2026-08-01T00:00:00.000Z'))

    expect(invoice).toBeNull()
  })

  it('does not match a ListarNF note whose "Informações Complementares" does not mention the order number', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ faultstring: 'NF nao encontrada' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          nfCadastro: [
            {
              compl: { nNF: '999' },
              det: [],
              informacoesAdicionais: { obsAdicFisco: 'Pedido Mercado Livre 555' },
            },
          ],
        }),
      })
    global.fetch = fetchMock as unknown as typeof fetch

    const invoice = await lookupInvoice('matriz', 111, new Date('2026-08-01T00:00:00.000Z'))

    expect(invoice).toBeNull()
  })

  it('throws on an HTTP error from ConsultarNF', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch

    await expect(lookupInvoice('matriz', 111, new Date('2026-08-01T00:00:00.000Z'))).rejects.toThrow(
      'Omie API error on ConsultarNF: 500'
    )
  })

  it('throws on an HTTP error from ListarNF', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ faultstring: 'NF nao encontrada' }) })
      .mockResolvedValueOnce({ ok: false, status: 500 })
    global.fetch = fetchMock as unknown as typeof fetch

    await expect(lookupInvoice('matriz', 111, new Date('2026-08-01T00:00:00.000Z'))).rejects.toThrow(
      'Omie API error on ListarNF: 500'
    )
  })
})
