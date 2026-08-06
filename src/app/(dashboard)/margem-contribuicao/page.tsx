import { createServerSupabaseClient } from '@/lib/supabase/server'
import { listProductCosts } from '@/lib/margin/productCosts'
import { calculateOrderMargin, summarizeMarginPeriod } from '@/lib/margin/calculateMargin'
import { formatCurrencyBRL } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ProductCostForm } from '@/components/ProductCostForm'
import { isSameMonth, subMonths } from 'date-fns'

interface OrderRow {
  id: string
  orderDate: string
  mlOrderId: number
  nfNumber: string | null
  buyerName: string | null
  destinationCity: string | null
  destinationState: string | null
  salesChannel: string | null
  saleAmount: number
  commission: number
  shippingOrFeeAmount: number
  shippingOrFeeType: 'frete' | 'taxa_fixa'
  nfPending: boolean
  items: { itemValue: number; ncm: string | null; mlItemId: string; title: string; quantity: number }[]
}

export default async function MargemContribuicaoPage() {
  const supabase = await createServerSupabaseClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold">Margem de contribuição</h1>
        <p className="text-sm text-muted-foreground">Faça login para ver seus dados.</p>
      </div>
    )
  }

  const [{ data: orders, error }, productCosts] = await Promise.all([
    supabase
      .from('orders')
      .select(
        'id, ml_order_id, order_date, total_amount, ml_commission, shipping_or_fee_amount, shipping_or_fee_type, destination_state, destination_city, buyer_name, sales_channel, nf_number, nf_fetched_at, order_items(ml_item_id, title, quantity, unit_price, ncm)'
      )
      .order('order_date', { ascending: false }),
    listProductCosts(supabase),
  ])

  const rows: OrderRow[] = (orders ?? []).map((order: Record<string, unknown>) => ({
    id: order.id as string,
    orderDate: order.order_date as string,
    mlOrderId: order.ml_order_id as number,
    nfNumber: order.nf_number as string | null,
    buyerName: order.buyer_name as string | null,
    destinationCity: order.destination_city as string | null,
    destinationState: order.destination_state as string | null,
    salesChannel: order.sales_channel as string | null,
    saleAmount: order.total_amount as number,
    commission: (order.ml_commission as number | null) ?? 0,
    shippingOrFeeAmount: (order.shipping_or_fee_amount as number | null) ?? 0,
    shippingOrFeeType: (order.shipping_or_fee_type as 'frete' | 'taxa_fixa' | null) ?? 'taxa_fixa',
    nfPending: order.nf_fetched_at === null,
    items: ((order.order_items ?? []) as { ml_item_id: string; title: string; quantity: number; unit_price: number; ncm: string | null }[]).map((item) => ({
      itemValue: item.unit_price * item.quantity,
      ncm: item.ncm,
      mlItemId: item.ml_item_id,
      title: item.title,
      quantity: item.quantity,
    })),
  }))

  const results = rows.map((row) => {
    const productCost = row.items.reduce((sum, item) => {
      const unitCost = productCosts[item.mlItemId]
      return unitCost === undefined ? sum : sum + unitCost * item.quantity
    }, 0)
    const anyCostMissing = row.items.length === 0 || row.items.some((item) => productCosts[item.mlItemId] === undefined)

    const margin = calculateOrderMargin({
      saleAmount: row.saleAmount,
      productCost: anyCostMissing ? null : productCost,
      commission: row.commission,
      shippingOrFeeAmount: row.shippingOrFeeAmount,
      shippingOrFeeType: row.shippingOrFeeType,
      items: row.items.map((item) => ({ itemValue: item.itemValue, ncm: item.ncm })),
      destinationState: row.destinationState,
      nfPending: row.nfPending,
    })

    return { row, margin, productCost: anyCostMissing ? null : productCost }
  })

  const now = new Date()
  const lastMonth = subMonths(now, 1)
  const accumulated = summarizeMarginPeriod(results.map((r) => ({ netProfit: r.margin.netProfit, productCost: r.productCost })))
  const currentMonth = summarizeMarginPeriod(
    results
      .filter((r) => isSameMonth(new Date(r.row.orderDate), now))
      .map((r) => ({ netProfit: r.margin.netProfit, productCost: r.productCost }))
  )
  const previousMonth = summarizeMarginPeriod(
    results
      .filter((r) => isSameMonth(new Date(r.row.orderDate), lastMonth))
      .map((r) => ({ netProfit: r.margin.netProfit, productCost: r.productCost }))
  )

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Margem de contribuição</h1>
      {error ? <p className="text-sm text-destructive">Não foi possível carregar os pedidos.</p> : null}

      <ProductCostForm userId={user.id} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Acumulado</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{accumulated.marginPct === null ? '—' : `${accumulated.marginPct.toFixed(1)}%`}</p>
            <p className="text-xs text-muted-foreground">Margem sobre custo</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Mês atual</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{currentMonth.marginPct === null ? '—' : `${currentMonth.marginPct.toFixed(1)}%`}</p>
            <p className="text-xs text-muted-foreground">Margem sobre custo</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Mês anterior</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{previousMonth.marginPct === null ? '—' : `${previousMonth.marginPct.toFixed(1)}%`}</p>
            <p className="text-xs text-muted-foreground">Margem sobre custo</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Pedido</TableHead>
                <TableHead>NF</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Cidade/UF</TableHead>
                <TableHead>Canal</TableHead>
                <TableHead>Produto(s)</TableHead>
                <TableHead className="text-right">Venda</TableHead>
                <TableHead className="text-right">Custo</TableHead>
                <TableHead className="text-right">Comissão</TableHead>
                <TableHead className="text-right">Frete/Taxa</TableHead>
                <TableHead className="text-right">Déb. ICMS</TableHead>
                <TableHead className="text-right">Lucro líquido</TableHead>
                <TableHead className="text-right">Margem %</TableHead>
                <TableHead className="text-right">Créd. PIS</TableHead>
                <TableHead className="text-right">Créd. COFINS</TableHead>
                <TableHead className="text-right">Créd. ICMS frete</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map(({ row, margin, productCost }) => (
                <TableRow key={row.id}>
                  <TableCell>{new Date(row.orderDate).toLocaleDateString('pt-BR')}</TableCell>
                  <TableCell>{row.mlOrderId}</TableCell>
                  <TableCell>{row.nfPending ? 'aguardando XML' : row.nfNumber}</TableCell>
                  <TableCell>{row.buyerName ?? '—'}</TableCell>
                  <TableCell>
                    {row.destinationCity && row.destinationState ? `${row.destinationCity}/${row.destinationState}` : '—'}
                  </TableCell>
                  <TableCell>{row.salesChannel ?? '—'}</TableCell>
                  <TableCell>{row.items.map((item) => item.title).join(', ')}</TableCell>
                  <TableCell className="text-right">{formatCurrencyBRL(row.saleAmount)}</TableCell>
                  <TableCell className="text-right">{productCost === null ? 'custo não cadastrado' : formatCurrencyBRL(productCost)}</TableCell>
                  <TableCell className="text-right">{formatCurrencyBRL(row.commission)}</TableCell>
                  <TableCell className="text-right">{formatCurrencyBRL(row.shippingOrFeeAmount)}</TableCell>
                  <TableCell className="text-right">
                    {margin.icmsDebit === null ? 'aguardando XML' : formatCurrencyBRL(margin.icmsDebit)}
                  </TableCell>
                  <TableCell className="text-right">
                    {margin.netProfit === null ? 'aguardando XML' : formatCurrencyBRL(margin.netProfit)}
                  </TableCell>
                  <TableCell className="text-right">
                    {margin.marginPct === null
                      ? productCost === null
                        ? 'custo não cadastrado'
                        : 'aguardando XML'
                      : `${margin.marginPct.toFixed(1)}%`}
                  </TableCell>
                  <TableCell className="text-right">{formatCurrencyBRL(margin.creditPis)}</TableCell>
                  <TableCell className="text-right">{formatCurrencyBRL(margin.creditCofins)}</TableCell>
                  <TableCell className="text-right">{formatCurrencyBRL(margin.creditIcmsOnShipping)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
