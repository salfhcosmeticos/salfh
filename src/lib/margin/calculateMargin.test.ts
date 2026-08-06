import { describe, it, expect } from 'vitest'
import { icmsDebitRate, calculateOrderMargin, summarizeMarginPeriod } from './calculateMargin'

describe('icmsDebitRate - matriz', () => {
  it('is 0% for a Parana destination with an exempt cosmetic NCM', () => {
    expect(icmsDebitRate('matriz', 'PR', '33059000')).toBe(0)
    expect(icmsDebitRate('matriz', 'PR', '33051000')).toBe(0)
  })

  it('is 19.5% for a Parana destination with a non-exempt NCM', () => {
    expect(icmsDebitRate('matriz', 'PR', '12345678')).toBe(0.195)
  })

  it('is 19.5% for a Parana destination with no NCM known yet', () => {
    expect(icmsDebitRate('matriz', 'PR', null)).toBe(0.195)
  })

  it('is 12% for MG, SP, RJ, SC and RS regardless of NCM', () => {
    for (const state of ['MG', 'SP', 'RJ', 'SC', 'RS']) {
      expect(icmsDebitRate('matriz', state, '33059000')).toBe(0.12)
      expect(icmsDebitRate('matriz', state, null)).toBe(0.12)
    }
  })

  it('is 7% for any other state', () => {
    expect(icmsDebitRate('matriz', 'BA', null)).toBe(0.07)
    expect(icmsDebitRate('matriz', 'AM', '33059000')).toBe(0.07)
  })

  it('returns null for an unrecognized destination instead of guessing a default rate', () => {
    expect(icmsDebitRate('matriz', 'São Paulo', null)).toBeNull()
    expect(icmsDebitRate('matriz', 'XX', '33059000')).toBeNull()
    expect(icmsDebitRate('matriz', '', null)).toBeNull()
  })
})

describe('icmsDebitRate - filial', () => {
  it('is 18% for SP', () => {
    expect(icmsDebitRate('filial', 'SP', null)).toBe(0.18)
    expect(icmsDebitRate('filial', 'SP', '33059000')).toBe(0.18)
  })

  it('is 12% for PR, RS, SC, RJ and MG, ignoring NCM (no cosmetic exemption on this table)', () => {
    for (const state of ['PR', 'RS', 'SC', 'RJ', 'MG']) {
      expect(icmsDebitRate('filial', state, null)).toBe(0.12)
      expect(icmsDebitRate('filial', state, '33059000')).toBe(0.12)
    }
  })

  it('is 7% for any other state', () => {
    expect(icmsDebitRate('filial', 'BA', null)).toBe(0.07)
    expect(icmsDebitRate('filial', 'AM', '33059000')).toBe(0.07)
  })

  it('returns null for an unrecognized destination', () => {
    expect(icmsDebitRate('filial', 'São Paulo', null)).toBeNull()
    expect(icmsDebitRate('filial', 'XX', null)).toBeNull()
    expect(icmsDebitRate('filial', '', null)).toBeNull()
  })
})

describe('calculateOrderMargin', () => {
  const baseInput = {
    saleAmount: 236.9,
    productCost: 100,
    commission: 41.66,
    shippingOrFeeAmount: 29,
    shippingOrFeeType: 'frete' as const,
    items: [
      { itemValue: 169.9, ncm: '33059000' },
      { itemValue: 67, ncm: '33059000' },
    ],
    destinationState: 'SP',
    nfPending: false,
    cnpj: 'matriz' as const,
  }

  it('computes ICMS debit as the sum across items using each item value and NCM', () => {
    const result = calculateOrderMargin(baseInput)
    expect(result.icmsDebit).toBeCloseTo(28.428, 3) // (169.9 + 67) * 0.12
  })

  it('computes net profit as sale amount minus ICMS debit, shipping/fee and commission', () => {
    const result = calculateOrderMargin(baseInput)
    expect(result.netProfit).toBeCloseTo(137.812, 3) // 236.9 - 28.428 - 29 - 41.66
  })

  it('computes margin % as net profit divided by product cost, times 100', () => {
    const result = calculateOrderMargin(baseInput)
    expect(result.marginPct).toBeCloseTo(137.812, 3) // 137.812 / 100 * 100
  })

  it('returns marginPct: null when product cost is not registered, without affecting netProfit', () => {
    const result = calculateOrderMargin({ ...baseInput, productCost: null })
    expect(result.marginPct).toBeNull()
    expect(result.netProfit).not.toBeNull()
  })

  it('returns marginPct: null when product cost is registered as zero, without affecting netProfit', () => {
    const result = calculateOrderMargin({ ...baseInput, productCost: 0 })
    expect(result.marginPct).toBeNull()
    expect(result.netProfit).not.toBeNull()
  })

  it('returns icmsDebit, netProfit and marginPct: null when the invoice has not been fetched yet', () => {
    const result = calculateOrderMargin({ ...baseInput, nfPending: true })
    expect(result.icmsDebit).toBeNull()
    expect(result.netProfit).toBeNull()
    expect(result.marginPct).toBeNull()
  })

  it('returns icmsDebit: null when the destination state is not yet known', () => {
    const result = calculateOrderMargin({ ...baseInput, destinationState: null })
    expect(result.icmsDebit).toBeNull()
  })

  it('returns icmsDebit, netProfit and marginPct: null when destinationState is an unrecognized value (e.g. a full state name), while still computing the three credits', () => {
    const result = calculateOrderMargin({ ...baseInput, destinationState: 'São Paulo' })
    expect(result.icmsDebit).toBeNull()
    expect(result.netProfit).toBeNull()
    expect(result.marginPct).toBeNull()
    expect(result.creditPis).toBeCloseTo((41.66 + 29) * 0.0165, 6)
    expect(result.creditCofins).toBeCloseTo((41.66 + 29) * 0.076, 6)
    expect(result.creditIcmsOnShipping).toBeCloseTo(29 * 0.12, 6)
  })

  it('returns icmsDebit, netProfit and marginPct: null when destinationState is an unrecognized two-letter code', () => {
    const result = calculateOrderMargin({ ...baseInput, destinationState: 'XX' })
    expect(result.icmsDebit).toBeNull()
    expect(result.netProfit).toBeNull()
    expect(result.marginPct).toBeNull()
  })

  it('applies the 0% exempt rate to a Parana order for the cosmetic NCM', () => {
    const result = calculateOrderMargin({ ...baseInput, destinationState: 'PR' })
    expect(result.icmsDebit).toBe(0)
  })

  it('sums ICMS per item using each item\'s own NCM, not one rate for the whole order', () => {
    const result = calculateOrderMargin({
      ...baseInput,
      destinationState: 'PR',
      items: [
        { itemValue: 169.9, ncm: '33059000' }, // exempt cosmetic -> 0%
        { itemValue: 67, ncm: '12345678' },    // non-exempt -> 19.5%
      ],
    })
    expect(result.icmsDebit).toBeCloseTo(13.065, 3) // 169.9*0 + 67*0.195
  })

  it('computes PIS, COFINS and ICMS-on-shipping credits from commission and shipping even when the NF is pending', () => {
    const result = calculateOrderMargin({ ...baseInput, nfPending: true })
    expect(result.creditPis).toBeCloseTo((41.66 + 29) * 0.0165, 6)
    expect(result.creditCofins).toBeCloseTo((41.66 + 29) * 0.076, 6)
    expect(result.creditIcmsOnShipping).toBeCloseTo(29 * 0.12, 6)
  })

  it('returns zero ICMS-on-shipping credit when the charge was a fixed fee, not freight', () => {
    const result = calculateOrderMargin({ ...baseInput, shippingOrFeeType: 'taxa_fixa' })
    expect(result.creditIcmsOnShipping).toBe(0)
  })

  it('selects the filial rate table when cnpj is "filial", instead of the matriz table', () => {
    // Matriz would apply 19.5% to PR with a non-exempt NCM (12345678); filial
    // applies its own flat 12% for PR regardless of NCM.
    const result = calculateOrderMargin({
      ...baseInput,
      cnpj: 'filial',
      destinationState: 'PR',
      items: [{ itemValue: 100, ncm: '12345678' }],
    })
    expect(result.icmsDebit).toBeCloseTo(12, 3) // 100 * 0.12
  })

  it('keeps the matriz table (including the PR cosmetic-NCM exemption) when cnpj is "matriz"', () => {
    const result = calculateOrderMargin({
      ...baseInput,
      cnpj: 'matriz',
      destinationState: 'PR',
      items: [{ itemValue: 100, ncm: '33059000' }],
    })
    expect(result.icmsDebit).toBe(0)
  })
})

describe('summarizeMarginPeriod', () => {
  it('sums net profit and product cost across orders, then derives a weighted margin', () => {
    const summary = summarizeMarginPeriod([
      { netProfit: 100, productCost: 50 },
      { netProfit: 200, productCost: 150 },
    ])
    expect(summary).toEqual({ netProfit: 300, productCost: 200, marginPct: 150 }) // 300/200*100
  })

  it('excludes orders with an unregistered cost or a pending invoice from the sums', () => {
    const summary = summarizeMarginPeriod([
      { netProfit: 100, productCost: 50 },
      { netProfit: null, productCost: null },
    ])
    expect(summary.netProfit).toBe(100)
    expect(summary.productCost).toBe(50)
  })

  it('returns marginPct: null and zero sums for an empty list', () => {
    expect(summarizeMarginPeriod([])).toEqual({ netProfit: 0, productCost: 0, marginPct: null })
  })
})
