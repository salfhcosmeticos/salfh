import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { consultarPedido, listarPedidos, listarNF, obterNfe, formatOmieDate } from './client'

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

describe('formatOmieDate', () => {
  it('formats as DD/MM/YYYY using UTC fields', () => {
    expect(formatOmieDate(new Date('2026-08-07T00:00:00.000Z'))).toBe('07/08/2026')
    expect(formatOmieDate(new Date('2026-01-05T23:00:00.000Z'))).toBe('05/01/2026')
  })
})

describe('consultarPedido', () => {
  it('returns numeroPedidoCliente from a real-shaped response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pedido_venda_produto: {
          cabecalho: { codigo_pedido: 11248244211 },
          informacoes_adicionais: { numero_pedido_cliente: '2000017307031470' },
        },
      }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await consultarPedido('matriz', 11248244211)

    expect(result).toEqual({ numeroPedidoCliente: '2000017307031470' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://app.omie.com.br/api/v1/produtos/pedido/',
      expect.objectContaining({ method: 'POST' })
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({
      call: 'ConsultarPedido',
      app_key: 'matriz-key',
      app_secret: 'matriz-secret',
      param: [{ codigo_pedido: 11248244211 }],
    })
  })

  it('returns numeroPedidoCliente: null when informacoes_adicionais is absent', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pedido_venda_produto: { cabecalho: { codigo_pedido: 1 } } }),
    }) as unknown as typeof fetch

    expect(await consultarPedido('matriz', 1)).toEqual({ numeroPedidoCliente: null })
  })

  it('uses the filial credentials when called with "filial"', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pedido_venda_produto: { cabecalho: { codigo_pedido: 1 } } }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    await consultarPedido('filial', 1)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({ app_key: 'filial-key', app_secret: 'filial-secret' })
  })

  it('throws on an HTTP error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch

    await expect(consultarPedido('matriz', 1)).rejects.toThrow('Omie API error on ConsultarPedido: 500')
  })
})

describe('listarPedidos', () => {
  it('maps pedido_venda_produto entries and total_de_paginas', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total_de_paginas: 32,
        pedido_venda_produto: [
          { cabecalho: { codigo_pedido: 11248244211 }, informacoes_adicionais: { numero_pedido_cliente: '2000017307031470' } },
          { cabecalho: { codigo_pedido: 999 } },
        ],
      }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const page = await listarPedidos('matriz', 1, '05/07/2026', '10/07/2026')

    expect(page).toEqual({
      totalPaginas: 32,
      pedidos: [
        { codigoPedido: 11248244211, numeroPedidoCliente: '2000017307031470' },
        { codigoPedido: 999, numeroPedidoCliente: null },
      ],
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({
      call: 'ListarPedidos',
      param: [{ pagina: 1, registros_por_pagina: 100, filtrar_por_data_de: '05/07/2026', filtrar_por_data_ate: '10/07/2026' }],
    })
  })

  it('throws on an HTTP error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch

    await expect(listarPedidos('matriz', 1, '05/07/2026', '10/07/2026')).rejects.toThrow(
      'Omie API error on ListarPedidos: 500'
    )
  })
})

describe('listarNF', () => {
  it('maps nfCadastro entries and total_de_paginas', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total_de_paginas: 7,
        nfCadastro: [{ compl: { nIdNF: 11248244216, nIdPedido: 11248244211 } }],
      }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const page = await listarNF('matriz', 1, '07/07/2026', '07/07/2026')

    expect(page).toEqual({ totalPaginas: 7, notas: [{ nIdNf: 11248244216, nIdPedido: 11248244211 }] })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({
      call: 'ListarNF',
      param: [{ pagina: 1, registros_por_pagina: 100, dEmiInicial: '07/07/2026', dEmiFinal: '07/07/2026' }],
    })
  })

  it('returns an empty list when nfCadastro is absent', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ total_de_paginas: 1 }),
    }) as unknown as typeof fetch

    expect(await listarNF('matriz', 1, '07/07/2026', '07/07/2026')).toEqual({ totalPaginas: 1, notas: [] })
  })

  it('throws on an HTTP error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch

    await expect(listarNF('matriz', 1, '07/07/2026', '07/07/2026')).rejects.toThrow('Omie API error on ListarNF: 500')
  })
})

describe('obterNfe', () => {
  it('returns the invoice fields and decodes the HTML-entity-encoded XML', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        cNumNfe: '00031513',
        nChaveNfe: '41260716864672000185550070000315131785292297',
        cXmlNfe: '&lt;?xml version=&quot;1.0&quot;?&gt;&lt;nfeProc&gt;&lt;/nfeProc&gt;',
        cPdf: 'https://click.omie.com/pdfnfe-2vspv6x5gup5',
        cCodStatus: '0',
        cDesStatus: 'Documentos gerados com sucesso!',
      }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const nfe = await obterNfe('matriz', 11248244216)

    expect(nfe).toEqual({
      invoiceNumber: '00031513',
      chaveNfe: '41260716864672000185550070000315131785292297',
      xml: '<?xml version="1.0"?><nfeProc></nfeProc>',
      pdfUrl: 'https://click.omie.com/pdfnfe-2vspv6x5gup5',
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({
      call: 'ObterNfe',
      param: [{ nIdNfe: 11248244216 }],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://app.omie.com.br/api/v1/produtos/dfedocs/',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('throws on an HTTP error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch

    await expect(obterNfe('matriz', 1)).rejects.toThrow('Omie API error on ObterNfe: 500')
  })
})
