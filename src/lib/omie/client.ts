import 'server-only'

export type OmieAccount = 'matriz' | 'filial'

function getCredentials(account: OmieAccount): { appKey: string; appSecret: string } {
  return account === 'filial'
    ? { appKey: process.env.OMIE_FILIAL_APP_KEY!, appSecret: process.env.OMIE_FILIAL_APP_SECRET! }
    : { appKey: process.env.OMIE_MATRIZ_APP_KEY!, appSecret: process.env.OMIE_MATRIZ_APP_SECRET! }
}

const OMIE_NF_ENDPOINT = 'https://app.omie.com.br/api/v1/produtos/nfconsultar/'
const LISTAR_NF_WINDOW_DAYS = 10

export interface OmieInvoiceItem {
  productCode: string
  ncm: string
}

export interface OmieInvoice {
  invoiceNumber: string
  items: OmieInvoiceItem[]
}

// Exact nesting/casing unconfirmed against a real Omie response - see this
// plan's Task 3 note and Task 9. Verify with one real ConsultarNF call
// before trusting this in production; adjust these field names if the real
// response differs.
interface OmieNfCadastro {
  compl: { nNF: string }
  det: { produto: { cProd: string; NCM: string } }[]
  informacoesAdicionais?: { obsAdicFisco?: string }
}

interface OmieConsultarNfResponse {
  faultstring?: string
  nfCadastro?: OmieNfCadastro
}

interface OmieListarNfResponse {
  faultstring?: string
  nfCadastro?: OmieNfCadastro[]
}

async function omiePost<T>(call: string, account: OmieAccount, param: Record<string, unknown>): Promise<T> {
  const { appKey, appSecret } = getCredentials(account)
  const response = await fetch(OMIE_NF_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ call, app_key: appKey, app_secret: appSecret, param: [param] }),
  })
  if (!response.ok) {
    throw new Error(`Omie API error on ${call}: ${response.status}`)
  }
  return response.json()
}

function toInvoice(nf: OmieNfCadastro): OmieInvoice {
  return {
    invoiceNumber: String(nf.compl.nNF),
    items: nf.det.map((line) => ({ productCode: String(line.produto.cProd), ncm: String(line.produto.NCM) })),
  }
}

function formatOmieDate(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const yyyy = date.getUTCFullYear()
  return `${dd}/${mm}/${yyyy}`
}

function invoiceMentionsOrder(nf: OmieNfCadastro, mlOrderId: number): boolean {
  const text = nf.informacoesAdicionais?.obsAdicFisco ?? ''
  return text.includes(String(mlOrderId))
}

export async function lookupInvoice(
  account: OmieAccount,
  mlOrderId: number,
  orderDate: Date
): Promise<OmieInvoice | null> {
  const direct = await omiePost<OmieConsultarNfResponse>('ConsultarNF', account, {
    cCodNFInt: String(mlOrderId),
  })
  if (direct.nfCadastro) return toInvoice(direct.nfCadastro)

  const windowEnd = new Date(orderDate.getTime() + LISTAR_NF_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const list = await omiePost<OmieListarNfResponse>('ListarNF', account, {
    nDataEmiInicial: formatOmieDate(orderDate),
    nDataEmiFinal: formatOmieDate(windowEnd),
  })
  const match = (list.nfCadastro ?? []).find((nf) => invoiceMentionsOrder(nf, mlOrderId))
  return match ? toInvoice(match) : null
}
