import { describe, it, expect } from 'vitest'
import { parseNfeXml } from './nfe'

const SINGLE_ITEM_NFE = `<?xml version="1.0"?>
<nfeProc><NFe><infNFe>
  <ide><nNF>123456</nNF></ide>
  <det nItem="1"><prod><cProd>SF9004</cProd><NCM>33059000</NCM></prod></det>
</infNFe></NFe></nfeProc>`

const MULTI_ITEM_NFE = `<?xml version="1.0"?>
<nfeProc><NFe><infNFe>
  <ide><nNF>654321</nNF></ide>
  <det nItem="1"><prod><cProd>SF9004</cProd><NCM>33059000</NCM></prod></det>
  <det nItem="2"><prod><cProd>SF9846</cProd><NCM>33051000</NCM></prod></det>
</infNFe></NFe></nfeProc>`

describe('parseNfeXml', () => {
  it('parses the invoice number and the single product line of a one-item invoice', () => {
    const result = parseNfeXml(SINGLE_ITEM_NFE)
    expect(result.invoiceNumber).toBe('123456')
    expect(result.items).toEqual([{ productCode: 'SF9004', ncm: '33059000' }])
  })

  it('parses every product line of a multi-item invoice', () => {
    const result = parseNfeXml(MULTI_ITEM_NFE)
    expect(result.invoiceNumber).toBe('654321')
    expect(result.items).toEqual([
      { productCode: 'SF9004', ncm: '33059000' },
      { productCode: 'SF9846', ncm: '33051000' },
    ])
  })

  it('throws a clear error when the XML has no infNFe block', () => {
    expect(() => parseNfeXml('<not-an-nfe/>')).toThrow(/infNFe/)
  })
})
