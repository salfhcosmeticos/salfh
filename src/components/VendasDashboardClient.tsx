'use client'

import { useEffect, useMemo, useState } from 'react'
import { createBrowserSupabaseClient } from '@/lib/supabase/browser'
import { fetchDashboardOrders, type DashboardOrderRow } from '@/lib/sales/fetchOrders'
import { filterRevenueOrders, summarizeRevenue } from '@/lib/sales/aggregate'
import { SummaryCards } from '@/components/SummaryCards'
import { SalesChart } from '@/components/SalesChart'
import { OrdersTable } from '@/components/OrdersTable'
import { LiveIndicator } from '@/components/LiveIndicator'

export function VendasDashboardClient({ initialOrders }: { initialOrders: DashboardOrderRow[] }) {
  const [orders, setOrders] = useState<DashboardOrderRow[]>(initialOrders)
  const [isLive, setIsLive] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)

  useEffect(() => {
    const supabase = createBrowserSupabaseClient()

    async function refetch() {
      const result = await fetchDashboardOrders(supabase)
      if (result.error) return
      setOrders(result.rows)
      setLastUpdatedAt(new Date())
    }

    const channel = supabase
      .channel('orders-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, refetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, refetch)
      .subscribe((status: string) => setIsLive(status === 'SUBSCRIBED'))

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const revenueRows = useMemo(() => filterRevenueOrders(orders), [orders])
  const summary = useMemo(() => summarizeRevenue(revenueRows), [revenueRows])

  return (
    <div className="flex flex-col gap-4">
      <LiveIndicator isLive={isLive} lastUpdatedAt={lastUpdatedAt} />
      <SummaryCards summary={summary} />
      <SalesChart orders={revenueRows.map((row) => ({ orderDate: row.orderDate, totalAmount: row.totalAmount }))} />
      <OrdersTable orders={orders} />
    </div>
  )
}
