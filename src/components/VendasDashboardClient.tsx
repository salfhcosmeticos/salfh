'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
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

  const latestRequestId = useRef(0)

  useEffect(() => {
    const supabase = createBrowserSupabaseClient()

    // A single order change fires both an `orders` event and an
    // `order_items` event within milliseconds of each other (upsertOrder
    // does two separate, non-transactional upserts), so two refetches can be
    // in flight at once. Network latency doesn't preserve issue order, so
    // guard against an earlier-issued refetch overwriting a later one that
    // resolves first — only the most recently *issued* refetch is allowed to
    // update state, regardless of which one *resolves* first.
    async function refetch() {
      const requestId = ++latestRequestId.current
      const result = await fetchDashboardOrders(supabase)
      if (requestId !== latestRequestId.current) return
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
