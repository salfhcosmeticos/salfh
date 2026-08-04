import { createServerSupabaseClient } from '@/lib/supabase/server'
import { ConnectMercadoLivreButton } from '@/components/ConnectMercadoLivreButton'
import { SummaryCards } from '@/components/SummaryCards'
import { OrdersTable } from '@/components/OrdersTable'
import { SalesChart } from '@/components/SalesChart'
import { filterRevenueOrders } from '@/lib/sales/aggregate'

export default async function HomePage() {
  const supabase = await createServerSupabaseClient()

  // The login gate is deliberately off for now, so an anonymous visitor just
  // hits RLS and gets zero rows — indistinguishable from "no orders yet"
  // unless we say so explicitly. This is not a redirect: the page still
  // renders, it just renders a different (honest) empty state.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return (
      <main>
        Dashboard de Vendas
        <p>Faça login para ver seus dados.</p>
      </main>
    )
  }

  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, status, total_amount, order_date, order_items(title)')
    .order('order_date', { ascending: false })

  if (error) {
    console.error('Falha ao carregar pedidos no dashboard:', error)
  }

  const rows = (orders ?? []).map((order) => ({
    id: order.id,
    status: order.status,
    totalAmount: order.total_amount,
    orderDate: order.order_date,
    itemsSummary: (order.order_items ?? []).map((item: { title: string }) => item.title).join(', '),
  }))

  // Only paid/shipped/delivered orders count as revenue — cancelled and
  // refunded ones would otherwise inflate Faturamento and Ticket médio.
  // OrdersTable deliberately keeps showing every order.
  const revenueRows = filterRevenueOrders(rows)
  const revenueTotal = revenueRows.reduce((sum, row) => sum + row.totalAmount, 0)
  const orderCount = revenueRows.length
  const averageTicket = orderCount > 0 ? revenueTotal / orderCount : 0

  return (
    <main>
      Dashboard de Vendas
      <ConnectMercadoLivreButton />
      {error ? <p>Não foi possível carregar seus pedidos. Tente novamente.</p> : null}
      <SummaryCards revenueTotal={revenueTotal} orderCount={orderCount} averageTicket={averageTicket} />
      <SalesChart
        orders={revenueRows.map((row) => ({ orderDate: row.orderDate, totalAmount: row.totalAmount }))}
      />
      <OrdersTable orders={rows} />
    </main>
  )
}
