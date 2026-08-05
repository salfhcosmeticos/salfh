import type { SupabaseClient } from '@supabase/supabase-js'

export interface DashboardOrderRow {
  id: string
  status: string
  totalAmount: number
  orderDate: string
  itemsSummary: string
}

export interface DashboardOrdersResult {
  rows: DashboardOrderRow[]
  error: boolean
}

export async function fetchDashboardOrders(supabase: SupabaseClient): Promise<DashboardOrdersResult> {
  const { data, error } = await supabase
    .from('orders')
    .select('id, status, total_amount, order_date, order_items(title)')
    .order('order_date', { ascending: false })

  if (error) {
    console.error('Falha ao carregar pedidos no dashboard:', error)
    return { rows: [], error: true }
  }

  const rows = (data ?? []).map((order: Record<string, unknown>) => ({
    id: order.id as string,
    status: order.status as string,
    totalAmount: order.total_amount as number,
    orderDate: order.order_date as string,
    itemsSummary: ((order.order_items ?? []) as { title: string }[]).map((item) => item.title).join(', '),
  }))

  return { rows, error: false }
}
