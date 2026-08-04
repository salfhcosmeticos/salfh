import { createServerSupabaseClient } from '@/lib/supabase/server'
import { ConnectMercadoLivreButton } from '@/components/ConnectMercadoLivreButton'
import { SummaryCards } from '@/components/SummaryCards'
import { OrdersTable } from '@/components/OrdersTable'
import { SalesChart } from '@/components/SalesChart'

export default async function HomePage() {
  const supabase = await createServerSupabaseClient()

  const { data: orders } = await supabase
    .from('orders')
    .select('id, status, total_amount, order_date, order_items(title)')
    .order('order_date', { ascending: false })

  const rows = (orders ?? []).map((order) => ({
    id: order.id,
    status: order.status,
    totalAmount: order.total_amount,
    orderDate: order.order_date,
    itemsSummary: (order.order_items ?? []).map((item: { title: string }) => item.title).join(', '),
  }))

  const revenueTotal = rows.reduce((sum, row) => sum + row.totalAmount, 0)
  const orderCount = rows.length
  const averageTicket = orderCount > 0 ? revenueTotal / orderCount : 0

  return (
    <main>
      Dashboard de Vendas
      <ConnectMercadoLivreButton />
      <SummaryCards revenueTotal={revenueTotal} orderCount={orderCount} averageTicket={averageTicket} />
      <SalesChart orders={rows.map((row) => ({ orderDate: row.orderDate, totalAmount: row.totalAmount }))} />
      <OrdersTable orders={rows} />
    </main>
  )
}
