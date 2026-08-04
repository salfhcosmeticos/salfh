import { format, startOfDay, startOfMonth, startOfWeek, startOfYear } from 'date-fns'

export type SalesGranularity = 'day' | 'week' | 'month' | 'year'

export interface SalesPoint {
  period: string
  revenue: number
  orderCount: number
}

export interface OrderForAggregation {
  orderDate: string
  totalAmount: number
}

const PERIOD_FORMATTERS: Record<SalesGranularity, (date: Date) => string> = {
  day: (date) => format(startOfDay(date), 'yyyy-MM-dd'),
  week: (date) => format(startOfWeek(date, { weekStartsOn: 1 }), 'yyyy-MM-dd'),
  month: (date) => format(startOfMonth(date), 'yyyy-MM'),
  year: (date) => format(startOfYear(date), 'yyyy'),
}

export function aggregateSales(orders: OrderForAggregation[], granularity: SalesGranularity): SalesPoint[] {
  const formatPeriod = PERIOD_FORMATTERS[granularity]
  const buckets = new Map<string, SalesPoint>()

  for (const order of orders) {
    const period = formatPeriod(new Date(order.orderDate))
    const bucket = buckets.get(period) ?? { period, revenue: 0, orderCount: 0 }
    bucket.revenue += order.totalAmount
    bucket.orderCount += 1
    buckets.set(period, bucket)
  }

  return Array.from(buckets.values()).sort((a, b) => a.period.localeCompare(b.period))
}
