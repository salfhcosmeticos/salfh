import { refreshMercadoLivreToken, type MercadoLivreTokens } from './oauth'

const ML_API_BASE = 'https://api.mercadolibre.com'

export interface MercadoLivreAccount {
  id: string
  accessToken: string
  refreshToken: string
  tokenExpiresAt: string
}

const RATE_LIMIT_MAX_RETRIES = 3

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function mlGet<T>(path: string, accessToken: string, attempt = 0): Promise<T> {
  const response = await fetch(`${ML_API_BASE}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (response.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES) {
    await wait(2 ** attempt * 1000)
    return mlGet<T>(path, accessToken, attempt + 1)
  }

  if (!response.ok) {
    throw new Error(`Mercado Livre API error on ${path}: ${response.status}`)
  }
  return response.json()
}

export async function getValidAccessToken(
  account: MercadoLivreAccount,
  onRefresh: (tokens: MercadoLivreTokens) => Promise<void>
): Promise<string> {
  const expiresAt = new Date(account.tokenExpiresAt).getTime()
  const isExpiringSoon = expiresAt - Date.now() < 5 * 60 * 1000
  if (!isExpiringSoon) {
    return account.accessToken
  }
  const tokens = await refreshMercadoLivreToken(account.refreshToken)
  await onRefresh(tokens)
  return tokens.accessToken
}

export interface MercadoLivreOrderItem {
  mlItemId: string
  title: string
  quantity: number
  unitPrice: number
  saleFee: number
}

export interface MercadoLivreOrder {
  id: number
  status: string
  totalAmount: number
  currencyId: string
  dateCreated: string
  items: MercadoLivreOrderItem[]
  shippingId: number | null
  salesChannel: string | null
}

interface MercadoLivreOrderResponse {
  id: number
  status: string
  total_amount: number
  currency_id: string
  date_created: string
  order_items: {
    item: { id: string; title: string }
    quantity: number
    unit_price: number
    sale_fee?: number
  }[]
  shipping: { id: number } | null
  tags?: string[]
}

function toOrder(response: MercadoLivreOrderResponse): MercadoLivreOrder {
  return {
    id: response.id,
    status: response.status,
    totalAmount: response.total_amount,
    currencyId: response.currency_id,
    dateCreated: response.date_created,
    items: response.order_items.map((entry) => ({
      mlItemId: entry.item.id,
      title: entry.item.title,
      quantity: entry.quantity,
      unitPrice: entry.unit_price,
      saleFee: entry.sale_fee ?? 0,
    })),
    shippingId: response.shipping?.id ?? null,
    salesChannel: response.tags?.[0] ?? null,
  }
}

export async function getOrder(accessToken: string, orderId: number): Promise<MercadoLivreOrder> {
  return toOrder(await mlGet<MercadoLivreOrderResponse>(`/orders/${orderId}`, accessToken))
}

export interface SearchOrdersResult {
  orders: MercadoLivreOrder[]
  total: number
}

export async function searchOrders(
  accessToken: string,
  sellerId: number,
  fromDate: string,
  toDate: string,
  offset: number
): Promise<SearchOrdersResult> {
  const params = new URLSearchParams({
    seller: String(sellerId),
    'order.date_created.from': fromDate,
    'order.date_created.to': toDate,
    offset: String(offset),
    limit: '50',
  })
  const response = await mlGet<{ results: MercadoLivreOrderResponse[]; paging: { total: number } }>(
    `/orders/search?${params.toString()}`,
    accessToken
  )
  return { orders: response.results.map(toOrder), total: response.paging.total }
}

export interface MercadoLivreShipmentAddress {
  city: string
  state: string
}

interface MercadoLivreShipmentResponse {
  receiver_address: { city: { name: string }; state: { id?: string; name: string } }
}

function extractUf(state: { id?: string; name: string }): string {
  const idMatch = state.id?.match(/^BR-([A-Z]{2})$/)
  if (idMatch) return idMatch[1]
  if (/^[A-Z]{2}$/.test(state.name)) return state.name
  return state.name // unrecognized shape; icmsDebitRate now rejects anything that isn't a real UF instead of silently guessing
}

export async function getShipmentAddress(accessToken: string, shippingId: number): Promise<MercadoLivreShipmentAddress> {
  const response = await mlGet<MercadoLivreShipmentResponse>(`/shipments/${shippingId}`, accessToken)
  return { city: response.receiver_address.city.name, state: extractUf(response.receiver_address.state) }
}

interface MercadoLivreShipmentCostsResponse {
  senders: { cost: number }[]
}

export async function getShipmentSellerCost(accessToken: string, shippingId: number): Promise<number> {
  const response = await mlGet<MercadoLivreShipmentCostsResponse>(`/shipments/${shippingId}/costs`, accessToken)
  return response.senders.reduce((sum, sender) => sum + sender.cost, 0)
}

export interface MercadoLivreBillingInfo {
  buyerName: string | null
}

interface MercadoLivreBillingInfoResponse {
  billing_info?: { name?: string; last_name?: string }
}

export async function getBillingInfo(accessToken: string, orderId: number): Promise<MercadoLivreBillingInfo> {
  const response = await mlGet<MercadoLivreBillingInfoResponse>(`/orders/${orderId}/billing_info`, accessToken)
  const info = response.billing_info
  if (!info?.name) return { buyerName: null }
  return { buyerName: info.last_name ? `${info.name} ${info.last_name}` : info.name }
}

export interface MercadoLivreFiscalDocumentRef {
  documentItemId: string
}

interface MercadoLivreFiscalDocumentsResponse {
  results: { items: { id: string }[] }[]
}

export async function findFiscalDocumentForOrder(
  accessToken: string,
  orderId: number
): Promise<MercadoLivreFiscalDocumentRef | null> {
  const response = await mlGet<MercadoLivreFiscalDocumentsResponse>(`/v2/fiscalDocuments?orderId=${orderId}`, accessToken)
  const documentItemId = response.results[0]?.items[0]?.id
  return documentItemId ? { documentItemId } : null
}

export async function downloadFiscalDocumentXml(accessToken: string, documentItemId: string): Promise<string> {
  const response = await fetch(`${ML_API_BASE}/v2/fiscalDocuments/download/${documentItemId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    throw new Error(`Mercado Livre fiscal document download error: ${response.status}`)
  }
  return response.text()
}
