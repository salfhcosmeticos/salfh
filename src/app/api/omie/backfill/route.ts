import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { listarPedidos, listarNF, obterNfe, formatOmieDate, type OmieAccount } from '@/lib/omie/client'
import { parseOmieNfeXml } from '@/lib/omie/nfe'
import { applyInvoiceToOrder } from '@/lib/omie/webhook'

const WINDOW_DAYS = 10
const PAGE_DELAY_MS = 150

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function findCodigoPedido(
  account: OmieAccount,
  mlOrderId: number,
  fromDate: Date,
  toDate: Date
): Promise<number | null> {
  let pagina = 1
  let totalPaginas = 1
  do {
    const page = await listarPedidos(account, pagina, formatOmieDate(fromDate), formatOmieDate(toDate))
    totalPaginas = page.totalPaginas
    const match = page.pedidos.find((p) => p.numeroPedidoCliente === String(mlOrderId))
    if (match) return match.codigoPedido
    pagina += 1
    if (pagina <= totalPaginas) await wait(PAGE_DELAY_MS)
  } while (pagina <= totalPaginas)
  return null
}

async function findNIdNf(account: OmieAccount, codigoPedido: number, fromDate: Date, toDate: Date): Promise<number | null> {
  let pagina = 1
  let totalPaginas = 1
  do {
    const page = await listarNF(account, pagina, formatOmieDate(fromDate), formatOmieDate(toDate))
    totalPaginas = page.totalPaginas
    const match = page.notas.find((nf) => nf.nIdPedido === codigoPedido)
    if (match) return match.nIdNf
    pagina += 1
    if (pagina <= totalPaginas) await wait(PAGE_DELAY_MS)
  } while (pagina <= totalPaginas)
  return null
}

// One-time, admin-triggered backfill for orders invoiced before the
// NFe.NotaAutorizada webhooks existed. Not a cron - everything going
// forward is covered by the webhook (src/app/api/webhooks/omie/route.ts)
// and its pending-invoice sweep (src/lib/omie/pendingInvoices.ts).
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 })
  }

  const serviceClient = createServiceClient()

  const { data: pendingOrders, error: queryError } = await serviceClient
    .from('orders')
    .select('id, ml_order_id, order_date, logistic_type')
    .is('nf_fetched_at', null)

  if (queryError) {
    return NextResponse.json({ error: queryError.message }, { status: 500 })
  }

  let processed = 0
  let errors = 0

  for (const order of pendingOrders ?? []) {
    try {
      const orderDate = new Date(order.order_date)
      const windowEnd = new Date(orderDate.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000)
      const firstAccount: OmieAccount = order.logistic_type === 'fulfillment' ? 'filial' : 'matriz'
      const secondAccount: OmieAccount = firstAccount === 'filial' ? 'matriz' : 'filial'

      let account = firstAccount
      let codigoPedido = await findCodigoPedido(firstAccount, order.ml_order_id, orderDate, windowEnd)
      if (codigoPedido === null) {
        account = secondAccount
        codigoPedido = await findCodigoPedido(secondAccount, order.ml_order_id, orderDate, windowEnd)
      }
      if (codigoPedido === null) continue // not invoiced yet, or outside the window - not an error

      const nIdNf = await findNIdNf(account, codigoPedido, orderDate, windowEnd)
      if (nIdNf === null) continue

      const nfe = await obterNfe(account, nIdNf)
      const invoice = parseOmieNfeXml(nfe.xml)
      const ncmByProductCode = Object.fromEntries(invoice.items.map((item) => [item.productCode, item.ncm]))

      await applyInvoiceToOrder(serviceClient, order.id, {
        nfNumber: nfe.invoiceNumber,
        // ObterNfe returns the XML content directly, not a link - there is
        // no URL to store for backfilled orders (unlike the webhook path,
        // which gets a direct CDN link in the event payload).
        nfeXmlUrl: null,
        nfeDanfeUrl: nfe.pdfUrl,
        ncmByProductCode,
      })

      processed += 1
    } catch {
      errors += 1
    }
  }

  return NextResponse.json({ processed, errors })
}
