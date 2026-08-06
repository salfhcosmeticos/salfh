import { XMLParser } from 'fast-xml-parser'

export interface NfeInvoiceData {
  invoiceNumber: string
  items: { productCode: string; ncm: string }[]
}

const parser = new XMLParser()

export function parseNfeXml(xml: string): NfeInvoiceData {
  const parsed = parser.parse(xml)
  const infNFe = parsed.nfeProc?.NFe?.infNFe ?? parsed.NFe?.infNFe
  if (!infNFe) {
    throw new Error('XML da nota fiscal não contém o bloco infNFe esperado')
  }

  const detList = Array.isArray(infNFe.det) ? infNFe.det : [infNFe.det]

  return {
    invoiceNumber: String(infNFe.ide.nNF),
    items: detList.map((det: { prod: { cProd: string; NCM: string } }) => ({
      productCode: String(det.prod.cProd),
      ncm: String(det.prod.NCM),
    })),
  }
}
