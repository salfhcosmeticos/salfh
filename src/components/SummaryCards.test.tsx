import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SummaryCards } from './SummaryCards'
import { formatCurrencyBRL } from '@/lib/format'
import type { RevenueSummary } from '@/lib/sales/aggregate'

// formatCurrencyBRL uses Intl.NumberFormat, which inserts a NBSP (U+00A0)
// between "R$" and the amount. @testing-library/dom's default normalizer
// collapses that NBSP to a regular space in the DOM text it matches against,
// but does NOT apply the same normalization to a plain-string matcher — so
// screen.getByText(formatCurrencyBRL(x)) can never match. A function matcher
// receives the already-normalized DOM text, so normalize the expected value
// the same way before comparing.
const NBSP = String.fromCharCode(160)
function currencyText(value: number) {
  const expected = formatCurrencyBRL(value).split(NBSP).join(' ')
  return (content: string) => content === expected
}

const summary: RevenueSummary = {
  total: 5000,
  today: { current: 100, previous: 40, changePct: 150 },
  week: { current: 300, previous: 600, changePct: -50 },
  month: { current: 2000, previous: 0, changePct: null },
}

describe('SummaryCards', () => {
  it('shows the total and each period current value', () => {
    render(<SummaryCards summary={summary} />)

    expect(screen.getByText(currencyText(5000))).toBeTruthy()
    expect(screen.getByText(currencyText(100))).toBeTruthy()
    expect(screen.getByText(currencyText(300))).toBeTruthy()
    expect(screen.getByText(currencyText(2000))).toBeTruthy()
  })

  it('shows a positive change badge for Hoje and a negative one for Semana', () => {
    render(<SummaryCards summary={summary} />)

    expect(screen.getByText('150.0%')).toBeTruthy()
    expect(screen.getByText('50.0%')).toBeTruthy()
  })

  it('shows "novo" instead of a percentage when the previous period was zero', () => {
    render(<SummaryCards summary={summary} />)

    expect(screen.getByText('novo')).toBeTruthy()
  })
})
