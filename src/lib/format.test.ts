import { describe, it, expect } from 'vitest'
import { formatCurrencyBRL } from './format'

describe('formatCurrencyBRL', () => {
  it('formats a positive value as BRL', () => {
    expect(formatCurrencyBRL(1234.5)).toBe('R$ 1.234,50')
  })

  it('formats zero', () => {
    expect(formatCurrencyBRL(0)).toBe('R$ 0,00')
  })
})
