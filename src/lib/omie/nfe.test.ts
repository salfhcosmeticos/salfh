import { describe, it, expect } from 'vitest'
import { parseOmieNfeXml } from './nfe'

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

describe('parseOmieNfeXml', () => {
  it('parses the invoice number and the single product line of a one-item invoice', () => {
    const result = parseOmieNfeXml(SINGLE_ITEM_NFE)
    expect(result.invoiceNumber).toBe('123456')
    expect(result.items).toEqual([{ productCode: 'SF9004', ncm: '33059000' }])
  })

  it('parses every product line of a multi-item invoice', () => {
    const result = parseOmieNfeXml(MULTI_ITEM_NFE)
    expect(result.invoiceNumber).toBe('654321')
    expect(result.items).toEqual([
      { productCode: 'SF9004', ncm: '33059000' },
      { productCode: 'SF9846', ncm: '33051000' },
    ])
  })

  it('throws a clear error when the XML has no infNFe block', () => {
    expect(() => parseOmieNfeXml('<not-an-nfe/>')).toThrow(/infNFe/)
  })

  it('preserves leading zeros in the product code instead of letting the XML parser coerce it to a number', () => {
    const xml = `<?xml version="1.0"?>
<nfeProc><NFe><infNFe>
  <ide><nNF>123456</nNF></ide>
  <det nItem="1"><prod><cProd>007</cProd><NCM>03051000</NCM></prod></det>
</infNFe></NFe></nfeProc>`

    const result = parseOmieNfeXml(xml)

    expect(result.items).toEqual([{ productCode: '007', ncm: '03051000' }])
  })

  it('strips formatting punctuation from NCM (Omie\'s structured API returns it dotted, e.g. "3305.90.00" - the raw XML may too)', () => {
    const xml = `<?xml version="1.0"?>
<nfeProc><NFe><infNFe>
  <ide><nNF>123456</nNF></ide>
  <det nItem="1"><prod><cProd>BB00078</cProd><NCM>3305.90.00</NCM></prod></det>
</infNFe></NFe></nfeProc>`

    const result = parseOmieNfeXml(xml)

    expect(result.items).toEqual([{ productCode: 'BB00078', ncm: '33059000' }])
  })
})
