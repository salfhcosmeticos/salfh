import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { VendasDashboardClient } from './VendasDashboardClient'
import { formatCurrencyBRL } from '@/lib/format'
import * as browserClient from '@/lib/supabase/browser'
import * as fetchOrdersModule from '@/lib/sales/fetchOrders'
import type { DashboardOrdersResult } from '@/lib/sales/fetchOrders'

// SalesChart renders recharts' ResponsiveContainer, which observes its
// container with ResizeObserver — a browser API jsdom doesn't implement.
// There's no shared vitest setup file in this project (see vitest.config.ts),
// so stub it locally rather than introducing one for a single test file.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

// formatCurrencyBRL uses Intl.NumberFormat, which inserts a NBSP (U+00A0)
// between "R$" and the amount. @testing-library/dom's default normalizer
// collapses that NBSP to a regular space in the DOM text it matches against,
// but does NOT apply the same normalization to a plain-string matcher — so
// screen.getByText(formatCurrencyBRL(x)) can never match. A function matcher
// receives the already-normalized DOM text, so normalize the expected value
// the same way before comparing (see also src/components/SummaryCards.test.tsx).
const NBSP = String.fromCharCode(160)
function currencyText(value: number) {
  const expected = formatCurrencyBRL(value).split(NBSP).join(' ')
  return (content: string) => content === expected
}

// summarizeRevenue buckets by the real wall-clock date (VendasDashboardClient
// doesn't pass a fixed `now`), and the fixture order dates below are close to
// "today" at any real test run. That means the same total can legitimately
// land in more than one place at once — e.g. Total, Semana and Mês all
// showing the same figure when the fixture's only order falls in the current
// week and month, and/or the OrdersTable row echoing the same amount as a
// KPI card. So "the value rendered somewhere" is checked with getAllByText
// (>= 1 match) rather than getByText, which requires exactly one match and
// throws on the (expected, not a bug) duplicates described above.
function expectCurrencyRendered(value: number) {
  expect(screen.getAllByText(currencyText(value)).length).toBeGreaterThan(0)
}

describe('VendasDashboardClient', () => {
  let changeHandler: (payload: unknown) => void

  beforeEach(() => {
    changeHandler = () => {}
    const channel = {
      on: vi.fn((_event: string, _filter: unknown, handler: (payload: unknown) => void) => {
        changeHandler = handler
        return channel
      }),
      subscribe: vi.fn((callback?: (status: string) => void) => {
        callback?.('SUBSCRIBED')
        return channel
      }),
    }
    vi.spyOn(browserClient, 'createBrowserSupabaseClient').mockReturnValue({
      channel: vi.fn().mockReturnValue(channel),
      removeChannel: vi.fn(),
    } as never)
  })

  it('renders the initial orders on first paint', () => {
    render(
      <VendasDashboardClient
        initialOrders={[
          { id: '1', status: 'paid', totalAmount: 100, orderDate: '2026-08-04T09:00:00.000Z', itemsSummary: 'Produto A' },
        ]}
      />
    )

    expectCurrencyRendered(100)
    expect(screen.getByText(/Ao vivo/)).toBeTruthy()
  })

  it('re-fetches and updates totals when a realtime event fires', async () => {
    vi.spyOn(fetchOrdersModule, 'fetchDashboardOrders').mockResolvedValue({
      rows: [
        { id: '1', status: 'paid', totalAmount: 100, orderDate: '2026-08-04T09:00:00.000Z', itemsSummary: 'Produto A' },
        { id: '2', status: 'paid', totalAmount: 250, orderDate: '2026-08-04T10:00:00.000Z', itemsSummary: 'Produto B' },
      ],
      error: false,
    })

    render(<VendasDashboardClient initialOrders={[]} />)

    const before = screen.getByTestId('last-updated').textContent

    changeHandler({})

    await waitFor(() => {
      expectCurrencyRendered(350)
    })
    expect(screen.getByTestId('last-updated').textContent).not.toBe(before)
  })

  it('applies only the most recently issued refetch when responses resolve out of order', async () => {
    // Reproduces the race the two-table (orders + order_items) subscription
    // was meant to eliminate: a single new order fires an `orders` event and
    // an `order_items` event milliseconds apart, so two refetches can be in
    // flight at once. Here call A (issued first, simulating the `orders`
    // event landing before the `order_items` upsert commits) is deliberately
    // resolved AFTER call B (issued second, simulating the `order_items`
    // event, with the complete row). Without a request-ordering guard, A's
    // stale response would land last and overwrite B's correct one.
    let resolveFirst!: (value: DashboardOrdersResult) => void
    let resolveSecond!: (value: DashboardOrdersResult) => void
    const firstCall = new Promise<DashboardOrdersResult>((resolve) => {
      resolveFirst = resolve
    })
    const secondCall = new Promise<DashboardOrdersResult>((resolve) => {
      resolveSecond = resolve
    })

    const fetchSpy = vi.spyOn(fetchOrdersModule, 'fetchDashboardOrders')
    fetchSpy.mockImplementationOnce(() => firstCall)
    fetchSpy.mockImplementationOnce(() => secondCall)

    render(<VendasDashboardClient initialOrders={[]} />)

    // Two events firing in quick succession -> two overlapping refetch() calls.
    changeHandler({})
    changeHandler({})

    // Later-issued call (B) resolves first, with the correct/complete data.
    resolveSecond({
      rows: [{ id: '1', status: 'paid', totalAmount: 100, orderDate: '2026-08-04T09:00:00.000Z', itemsSummary: 'Produto A' }],
      error: false,
    })
    await waitFor(() => {
      expectCurrencyRendered(100)
    })

    // Earlier-issued call (A) resolves last, with stale/incomplete data. It
    // must be discarded, not applied on top of B's already-correct state.
    resolveFirst({
      rows: [{ id: '1', status: 'paid', totalAmount: 999, orderDate: '2026-08-04T09:00:00.000Z', itemsSummary: '' }],
      error: false,
    })

    // Flush microtasks so the (would-be, buggy) update has a chance to apply.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expectCurrencyRendered(100)
    expect(screen.queryByText(currencyText(999))).toBeNull()
  })

  it('keeps the last known snapshot when a refetch fails', async () => {
    vi.spyOn(fetchOrdersModule, 'fetchDashboardOrders').mockResolvedValue({ rows: [], error: true })

    render(
      <VendasDashboardClient
        initialOrders={[
          { id: '1', status: 'paid', totalAmount: 100, orderDate: '2026-08-04T09:00:00.000Z', itemsSummary: 'Produto A' },
        ]}
      />
    )

    changeHandler({})

    await waitFor(() => {
      expect(fetchOrdersModule.fetchDashboardOrders).toHaveBeenCalled()
    })
    expectCurrencyRendered(100)
  })
})
