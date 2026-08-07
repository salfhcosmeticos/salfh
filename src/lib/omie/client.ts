import 'server-only'

export type OmieAccount = 'matriz' | 'filial'

function getCredentials(account: OmieAccount): { appKey: string; appSecret: string } {
  return account === 'filial'
    ? { appKey: process.env.OMIE_FILIAL_APP_KEY!, appSecret: process.env.OMIE_FILIAL_APP_SECRET! }
    : { appKey: process.env.OMIE_MATRIZ_APP_KEY!, appSecret: process.env.OMIE_MATRIZ_APP_SECRET! }
}

const OMIE_PEDIDO_ENDPOINT = 'https://app.omie.com.br/api/v1/produtos/pedido/'
const OMIE_NF_ENDPOINT = 'https://app.omie.com.br/api/v1/produtos/nfconsultar/'
const OMIE_DFE_ENDPOINT = 'https://app.omie.com.br/api/v1/produtos/dfedocs/'
const RECORDS_PER_PAGE = 100

async function omiePost<T>(endpoint: string, call: string, account: OmieAccount, param: Record<string, unknown>): Promise<T> {
  const { appKey, appSecret } = getCredentials(account)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ call, app_key: appKey, app_secret: appSecret, param: [param] }),
  })
  if (!response.ok) {
    throw new Error(`Omie API error on ${call}: ${response.status}`)
  }
  return response.json()
}

// Confirmed live (2026-08-07) that Omie's list endpoints (ListarPedidos,
// ListarNF) respond with an HTTP error whose body is a "fault" - not a
// normal 200 with an empty array - when a page/date-window genuinely has
// zero matching records ("Não existem registros para a página [1]!",
// faultcode SOAP-ENV:Client-5113). That's an expected empty-result outcome
// for a paginated search, not a failure, so it must not throw. Every other
// non-ok response (auth failure, malformed params, etc.) still throws.
const NO_RECORDS_FAULT_CODE = 'SOAP-ENV:Client-5113'

interface OmieFaultResponse {
  faultstring?: string
  faultcode?: string
}

async function omiePostListing<T>(
  endpoint: string,
  call: string,
  account: OmieAccount,
  param: Record<string, unknown>
): Promise<T | null> {
  const { appKey, appSecret } = getCredentials(account)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ call, app_key: appKey, app_secret: appSecret, param: [param] }),
  })
  const body = await response.json()
  if (!response.ok) {
    if ((body as OmieFaultResponse).faultcode === NO_RECORDS_FAULT_CODE) {
      return null
    }
    throw new Error(`Omie API error on ${call}: ${response.status}`)
  }
  return body as T
}

export function formatOmieDate(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const yyyy = date.getUTCFullYear()
  return `${dd}/${mm}/${yyyy}`
}

// --- Pedido de Venda ---
//
// Exact nesting confirmed against a real ListarPedidos entry this session
// (informacoes_adicionais.numero_pedido_cliente holds the Mercado Livre
// order number). ConsultarPedido returns the same pedido_venda_produto
// object family but was only spot-checked up to cabecalho/det - verify
// informacoes_adicionais is present the same way with one real call before
// trusting this in production (Task 9's rollout does this).
interface OmiePedidoCabecalho {
  codigo_pedido: number
}

interface OmiePedidoInformacoesAdicionais {
  numero_pedido_cliente?: string
}

interface OmiePedidoVendaProduto {
  cabecalho: OmiePedidoCabecalho
  informacoes_adicionais?: OmiePedidoInformacoesAdicionais
}

interface OmieConsultarPedidoResponse {
  pedido_venda_produto: OmiePedidoVendaProduto
}

export async function consultarPedido(
  account: OmieAccount,
  codigoPedido: number
): Promise<{ numeroPedidoCliente: string | null }> {
  const response = await omiePost<OmieConsultarPedidoResponse>(OMIE_PEDIDO_ENDPOINT, 'ConsultarPedido', account, {
    codigo_pedido: codigoPedido,
  })
  return { numeroPedidoCliente: response.pedido_venda_produto.informacoes_adicionais?.numero_pedido_cliente ?? null }
}

export interface OmiePedidoListItem {
  codigoPedido: number
  numeroPedidoCliente: string | null
}

export interface OmiePedidoPage {
  pedidos: OmiePedidoListItem[]
  totalPaginas: number
}

interface OmieListarPedidosResponse {
  total_de_paginas: number
  pedido_venda_produto?: OmiePedidoVendaProduto[]
}

export async function listarPedidos(
  account: OmieAccount,
  pagina: number,
  dataInicial: string,
  dataFinal: string
): Promise<OmiePedidoPage> {
  const response = await omiePostListing<OmieListarPedidosResponse>(OMIE_PEDIDO_ENDPOINT, 'ListarPedidos', account, {
    pagina,
    registros_por_pagina: RECORDS_PER_PAGE,
    filtrar_por_data_de: dataInicial,
    filtrar_por_data_ate: dataFinal,
  })
  if (!response) {
    return { totalPaginas: 0, pedidos: [] }
  }
  return {
    totalPaginas: response.total_de_paginas,
    pedidos: (response.pedido_venda_produto ?? []).map((p) => ({
      codigoPedido: p.cabecalho.codigo_pedido,
      numeroPedidoCliente: p.informacoes_adicionais?.numero_pedido_cliente ?? null,
    })),
  }
}

// --- Nota Fiscal (nfconsultar) ---

export interface OmieNfListItem {
  nIdNf: number
  nIdPedido: number
}

export interface OmieNfPage {
  notas: OmieNfListItem[]
  totalPaginas: number
}

interface OmieNfComplSummary {
  nIdNF: number
  nIdPedido: number
}

interface OmieListarNfResponse {
  total_de_paginas: number
  nfCadastro?: { compl: OmieNfComplSummary }[]
}

export async function listarNF(
  account: OmieAccount,
  pagina: number,
  dEmiInicial: string,
  dEmiFinal: string
): Promise<OmieNfPage> {
  const response = await omiePostListing<OmieListarNfResponse>(OMIE_NF_ENDPOINT, 'ListarNF', account, {
    pagina,
    registros_por_pagina: RECORDS_PER_PAGE,
    dEmiInicial,
    dEmiFinal,
  })
  if (!response) {
    return { totalPaginas: 0, notas: [] }
  }
  return {
    totalPaginas: response.total_de_paginas,
    notas: (response.nfCadastro ?? []).map((nf) => ({ nIdNf: nf.compl.nIdNF, nIdPedido: nf.compl.nIdPedido })),
  }
}

// --- Documento Fiscal Eletrônico (dfedocs) ---

export interface OmieNfeDocument {
  invoiceNumber: string
  chaveNfe: string
  xml: string
  pdfUrl: string
}

interface OmieObterNfeResponse {
  cNumNfe: string
  nChaveNfe: string
  cXmlNfe: string
  cPdf: string
}

function decodeXmlEntities(encoded: string): string {
  return encoded.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

export async function obterNfe(account: OmieAccount, nIdNfe: number): Promise<OmieNfeDocument> {
  const response = await omiePost<OmieObterNfeResponse>(OMIE_DFE_ENDPOINT, 'ObterNfe', account, { nIdNfe })
  return {
    invoiceNumber: response.cNumNfe,
    chaveNfe: response.nChaveNfe,
    xml: decodeXmlEntities(response.cXmlNfe),
    pdfUrl: response.cPdf,
  }
}
