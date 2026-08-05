const ICMS_TWELVE_PERCENT_STATES = ['MG', 'SP', 'RJ', 'SC', 'RS']
const ICMS_EXEMPT_COSMETIC_NCMS = ['33059000', '33051000']
const PIS_CREDIT_RATE = 0.0165
const COFINS_CREDIT_RATE = 0.076
const ICMS_SHIPPING_CREDIT_RATE = 0.12

export function icmsDebitRate(destinationState: string, ncm: string | null): number {
  const isExemptCosmeticToParana = destinationState === 'PR' && ncm !== null && ICMS_EXEMPT_COSMETIC_NCMS.includes(ncm)
  if (isExemptCosmeticToParana) return 0
  if (destinationState === 'PR') return 0.195
  if (ICMS_TWELVE_PERCENT_STATES.includes(destinationState)) return 0.12
  return 0.07
}

export interface OrderMarginItem {
  itemValue: number
  ncm: string | null
}

export interface OrderMarginInput {
  saleAmount: number
  productCost: number | null
  commission: number
  shippingOrFeeAmount: number
  shippingOrFeeType: 'frete' | 'taxa_fixa'
  items: OrderMarginItem[]
  destinationState: string | null
  nfPending: boolean
}

export interface OrderMarginResult {
  icmsDebit: number | null
  netProfit: number | null
  marginPct: number | null
  creditPis: number
  creditCofins: number
  creditIcmsOnShipping: number
}

export function calculateOrderMargin(input: OrderMarginInput): OrderMarginResult {
  const creditPis = (input.commission + input.shippingOrFeeAmount) * PIS_CREDIT_RATE
  const creditCofins = (input.commission + input.shippingOrFeeAmount) * COFINS_CREDIT_RATE
  const creditIcmsOnShipping =
    input.shippingOrFeeType === 'frete' ? input.shippingOrFeeAmount * ICMS_SHIPPING_CREDIT_RATE : 0

  if (input.nfPending || input.destinationState === null) {
    return { icmsDebit: null, netProfit: null, marginPct: null, creditPis, creditCofins, creditIcmsOnShipping }
  }

  const destinationState = input.destinationState
  const icmsDebit = input.items.reduce(
    (sum, item) => sum + item.itemValue * icmsDebitRate(destinationState, item.ncm),
    0
  )
  const netProfit = input.saleAmount - icmsDebit - input.shippingOrFeeAmount - input.commission
  const marginPct = input.productCost === null || input.productCost === 0 ? null : (netProfit / input.productCost) * 100

  return { icmsDebit, netProfit, marginPct, creditPis, creditCofins, creditIcmsOnShipping }
}

export interface MarginPeriodSummary {
  netProfit: number
  productCost: number
  marginPct: number | null
}

export function summarizeMarginPeriod(
  orders: { netProfit: number | null; productCost: number | null }[]
): MarginPeriodSummary {
  const complete = orders.filter(
    (order): order is { netProfit: number; productCost: number } =>
      order.netProfit !== null && order.productCost !== null
  )
  const netProfit = complete.reduce((sum, order) => sum + order.netProfit, 0)
  const productCost = complete.reduce((sum, order) => sum + order.productCost, 0)
  return { netProfit, productCost, marginPct: productCost === 0 ? null : (netProfit / productCost) * 100 }
}
