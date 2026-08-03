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
}

export interface MercadoLivreOrder {
  id: number
  status: string
  totalAmount: number
  currencyId: string
  dateCreated: string
  items: MercadoLivreOrderItem[]
}

interface MercadoLivreOrderResponse {
  id: number
  status: string
  total_amount: number
  currency_id: string
  date_created: string
  order_items: { item: { id: string; title: string }; quantity: number; unit_price: number }[]
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
    })),
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
