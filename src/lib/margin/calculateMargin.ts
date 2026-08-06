const ICMS_TWELVE_PERCENT_STATES = ['MG', 'SP', 'RJ', 'SC', 'RS']
const ICMS_EXEMPT_COSMETIC_NCMS = ['33059000', '33051000']
const ICMS_FILIAL_TWELVE_PERCENT_STATES = ['PR', 'RS', 'SC', 'RJ', 'MG']
const PIS_CREDIT_RATE = 0.0165
const COFINS_CREDIT_RATE = 0.076
const ICMS_SHIPPING_CREDIT_RATE = 0.12

const VALID_UFS = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG',
  'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
]

export type BillingCnpj = 'matriz' | 'filial'

function icmsDebitRateMatriz(destinationState: string, ncm: string | null): number | null {
  if (!VALID_UFS.includes(destinationState)) return null
  const isExemptCosmeticToParana = destinationState === 'PR' && ncm !== null && ICMS_EXEMPT_COSMETIC_NCMS.includes(ncm)
  if (isExemptCosmeticToParana) return 0
  if (destinationState === 'PR') return 0.195
  if (ICMS_TWELVE_PERCENT_STATES.includes(destinationState)) return 0.12
  return 0.07
}

function icmsDebitRateFilial(destinationState: string): number | null {
  if (!VALID_UFS.includes(destinationState)) return null
  if (destinationState === 'SP') return 0.18
  if (ICMS_FILIAL_TWELVE_PERCENT_STATES.includes(destinationState)) return 0.12
  return 0.07
}

export function icmsDebitRate(cnpj: BillingCnpj, destinationState: string, ncm: string | null): number | null {
  return cnpj === 'filial' ? icmsDebitRateFilial(destinationState) : icmsDebitRateMatriz(destinationState, ncm)
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
  cnpj: BillingCnpj
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

  const isValidDestination = input.destinationState !== null && VALID_UFS.includes(input.destinationState)

  if (input.nfPending || !isValidDestination) {
    return { icmsDebit: null, netProfit: null, marginPct: null, creditPis, creditCofins, creditIcmsOnShipping }
  }

  const destinationState = input.destinationState as string
  const icmsDebit = input.items.reduce(
    (sum, item) => sum + item.itemValue * (icmsDebitRate(input.cnpj, destinationState, item.ncm) ?? 0),
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
