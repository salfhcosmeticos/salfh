import { XMLParser } from 'fast-xml-parser'

export interface OmieNfeXmlItem {
  productCode: string
  ncm: string
}

export interface OmieNfeXmlData {
  invoiceNumber: string
  items: OmieNfeXmlItem[]
}

const parser = new XMLParser({ parseTagValue: false, processEntities: false })

function normalizeNcm(raw: string): string {
  return raw.replace(/\D/g, '')
}

export function parseOmieNfeXml(xml: string): OmieNfeXmlData {
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
      ncm: normalizeNcm(String(det.prod.NCM)),
    })),
  }
}
