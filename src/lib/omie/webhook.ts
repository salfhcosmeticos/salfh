import type { SupabaseClient } from '@supabase/supabase-js'
import { consultarPedido, type OmieAccount } from './client'
import { parseOmieNfeXml } from './nfe'

interface OmieNfeAutorizadaEvent {
  id_pedido: number
  id_nf: number
  numero_nf: string
  nfe_xml: string
  nfe_danfe: string
}

interface OmieNfeAutorizadaPayload {
  topic: 'NFe.NotaAutorizada'
  event: OmieNfeAutorizadaEvent
}

function isNfeAutorizadaPayload(payload: unknown): payload is OmieNfeAutorizadaPayload {
  if (!payload || typeof payload !== 'object') return false
  const candidate = payload as Record<string, unknown>
  if (candidate.topic !== 'NFe.NotaAutorizada') return false
  const event = candidate.event
  if (!event || typeof event !== 'object') return false
  const e = event as Record<string, unknown>
  return (
    typeof e.id_pedido === 'number' &&
    typeof e.id_nf === 'number' &&
    typeof e.numero_nf === 'string' &&
    typeof e.nfe_xml === 'string' &&
    typeof e.nfe_danfe === 'string'
  )
}

export interface InvoiceToApply {
  nfNumber: string
  nfeXmlUrl: string | null
  nfeDanfeUrl: string | null
  ncmByProductCode: Record<string, string>
}

export async function applyInvoiceToOrder(
  supabase: SupabaseClient,
  orderId: string,
  invoice: InvoiceToApply
): Promise<void> {
  await supabase
    .from('orders')
    .update({
      nf_number: invoice.nfNumber,
      nf_fetched_at: new Date().toISOString(),
      nfe_xml_url: invoice.nfeXmlUrl,
      nfe_danfe_url: invoice.nfeDanfeUrl,
    })
    .eq('id', orderId)

  const { data: items } = await supabase.from('order_items').select('id, product_code').eq('order_id', orderId)

  for (const item of items ?? []) {
    const ncm = item.product_code ? invoice.ncmByProductCode[item.product_code] : undefined
    if (ncm) {
      await supabase.from('order_items').update({ ncm }).eq('id', item.id)
    }
  }
}

export async function handleOmieWebhook(supabase: SupabaseClient, account: OmieAccount, payload: unknown): Promise<void> {
  if (!isNfeAutorizadaPayload(payload)) {
    return // Not a topic we act on (e.g. produto.alterado), or malformed - ignore, don't error.
  }

  const { event } = payload

  const { numeroPedidoCliente } = await consultarPedido(account, event.id_pedido)
  if (!numeroPedidoCliente) {
    // No Mercado Livre order number recorded on this Pedido - nothing to
    // link the invoice to. Not this handler's job to guess further.
    return
  }

  const mlOrderId = Number(numeroPedidoCliente)
  if (!Number.isFinite(mlOrderId)) {
    return
  }

  const xmlResponse = await fetch(event.nfe_xml)
  if (!xmlResponse.ok) {
    throw new Error(`Failed to download NFe XML: ${xmlResponse.status}`)
  }
  const invoice = parseOmieNfeXml(await xmlResponse.text())
  const ncmByProductCode = Object.fromEntries(invoice.items.map((item) => [item.productCode, item.ncm]))

  const { data: orderRow } = await supabase.from('orders').select('id').eq('ml_order_id', mlOrderId).maybeSingle()

  if (!orderRow) {
    // Order not synced from Mercado Livre yet - park it for
    // applyPendingOmieInvoices (Task 5) to pick up once it arrives, rather
    // than dropping a real invoice notification.
    await supabase.from('pending_omie_invoices').upsert(
      {
        ml_order_id: mlOrderId,
        nf_number: event.numero_nf,
        nfe_xml_url: event.nfe_xml,
        nfe_danfe_url: event.nfe_danfe,
        ncm_by_product_code: ncmByProductCode,
      },
      { onConflict: 'ml_order_id' }
    )
    return
  }

  await applyInvoiceToOrder(supabase, orderRow.id, {
    nfNumber: event.numero_nf,
    nfeXmlUrl: event.nfe_xml,
    nfeDanfeUrl: event.nfe_danfe,
    ncmByProductCode,
  })
}
