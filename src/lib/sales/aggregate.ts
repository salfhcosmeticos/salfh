import {
  format,
  isSameDay,
  isSameISOWeek,
  isSameMonth,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
  subDays,
  subMonths,
  subWeeks,
} from 'date-fns'

/**
 * Order statuses that count toward Faturamento / Ticket médio (owner decision).
 * Cancelled and refunded orders stay visible in the orders table but must not
 * inflate the revenue figures. Values are Mercado Livre's `status` field, stored
 * verbatim by the client's `toOrder` mapping.
 */
export const REVENUE_STATUSES = ['paid', 'shipped', 'delivered'] as const

export function isRevenueStatus(status: string): boolean {
  return (REVENUE_STATUSES as readonly string[]).includes(status)
}

export function filterRevenueOrders<T extends { status: string }>(orders: T[]): T[] {
  return orders.filter((order) => isRevenueStatus(order.status))
}

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

export interface PeriodComparison {
  current: number
  previous: number
  changePct: number | null // null = previous period had zero revenue, no % shown
}

export interface RevenueSummary {
  total: number
  today: PeriodComparison
  week: PeriodComparison
  month: PeriodComparison
}

function sumWhere(orders: OrderForAggregation[], predicate: (date: Date) => boolean): number {
  return orders
    .filter((order) => predicate(new Date(order.orderDate)))
    .reduce((sum, order) => sum + order.totalAmount, 0)
}

function comparePeriods(current: number, previous: number): PeriodComparison {
  return { current, previous, changePct: previous === 0 ? null : ((current - previous) / previous) * 100 }
}

export function summarizeRevenue(orders: OrderForAggregation[], now: Date = new Date()): RevenueSummary {
  const total = orders.reduce((sum, order) => sum + order.totalAmount, 0)

  const yesterday = subDays(now, 1)
  const lastWeek = subWeeks(now, 1)
  const lastMonth = subMonths(now, 1)

  return {
    total,
    today: comparePeriods(
      sumWhere(orders, (date) => isSameDay(date, now)),
      sumWhere(orders, (date) => isSameDay(date, yesterday))
    ),
    week: comparePeriods(
      sumWhere(orders, (date) => isSameISOWeek(date, now)),
      sumWhere(orders, (date) => isSameISOWeek(date, lastWeek))
    ),
    month: comparePeriods(
      sumWhere(orders, (date) => isSameMonth(date, now)),
      sumWhere(orders, (date) => isSameMonth(date, lastMonth))
    ),
  }
}
