import { describe, it, expect } from 'vitest'
import { aggregateSales, filterRevenueOrders, isRevenueStatus, REVENUE_STATUSES } from './aggregate'

const orders = [
  { orderDate: '2026-08-01T10:00:00.000Z', totalAmount: 100 },
  { orderDate: '2026-08-01T15:00:00.000Z', totalAmount: 50 },
  { orderDate: '2026-08-02T09:00:00.000Z', totalAmount: 75 },
  { orderDate: '2025-08-05T09:00:00.000Z', totalAmount: 200 },
]

describe('aggregateSales', () => {
  it('groups by day', () => {
    const result = aggregateSales(orders, 'day')
    expect(result).toEqual([
      { period: '2025-08-05', revenue: 200, orderCount: 1 },
      { period: '2026-08-01', revenue: 150, orderCount: 2 },
      { period: '2026-08-02', revenue: 75, orderCount: 1 },
    ])
  })

  it('groups by month', () => {
    const result = aggregateSales(orders, 'month')
    expect(result).toEqual([
      { period: '2025-08', revenue: 200, orderCount: 1 },
      { period: '2026-08', revenue: 225, orderCount: 3 },
    ])
  })

  it('groups by year', () => {
    const result = aggregateSales(orders, 'year')
    expect(result).toEqual([
      { period: '2025', revenue: 200, orderCount: 1 },
      { period: '2026', revenue: 225, orderCount: 3 },
    ])
  })

  it('groups by week', () => {
    const result = aggregateSales(
      [
        { orderDate: '2026-08-03T10:00:00.000Z', totalAmount: 10 },
        { orderDate: '2026-08-04T10:00:00.000Z', totalAmount: 20 },
      ],
      'week'
    )
    expect(result).toHaveLength(1)
    expect(result[0].revenue).toBe(30)
    expect(result[0].orderCount).toBe(2)
  })

  it('returns an empty array for no orders', () => {
    expect(aggregateSales([], 'day')).toEqual([])
  })
})

describe('revenue status filtering', () => {
  it('counts only paid, shipped and delivered as revenue', () => {
    expect(REVENUE_STATUSES).toEqual(['paid', 'shipped', 'delivered'])
    expect(isRevenueStatus('paid')).toBe(true)
    expect(isRevenueStatus('shipped')).toBe(true)
    expect(isRevenueStatus('delivered')).toBe(true)
  })

  it('excludes cancelled, refunded and other non-revenue statuses', () => {
    expect(isRevenueStatus('cancelled')).toBe(false)
    expect(isRevenueStatus('refunded')).toBe(false)
    expect(isRevenueStatus('payment_required')).toBe(false)
    expect(isRevenueStatus('payment_in_process')).toBe(false)
    expect(isRevenueStatus('invalid')).toBe(false)
    expect(isRevenueStatus('')).toBe(false)
  })

  it('drops non-revenue orders so they cannot inflate revenue totals', () => {
    const rows = [
      { id: '1', status: 'paid', totalAmount: 100 },
      { id: '2', status: 'cancelled', totalAmount: 999 },
      { id: '3', status: 'delivered', totalAmount: 50 },
      { id: '4', status: 'refunded', totalAmount: 999 },
      { id: '5', status: 'shipped', totalAmount: 25 },
    ]

    const revenueRows = filterRevenueOrders(rows)

    expect(revenueRows.map((row) => row.id)).toEqual(['1', '3', '5'])
    expect(revenueRows.reduce((sum, row) => sum + row.totalAmount, 0)).toBe(175)
  })

  it('returns an empty list when no order qualifies', () => {
    expect(filterRevenueOrders([{ status: 'cancelled' }])).toEqual([])
  })
})
