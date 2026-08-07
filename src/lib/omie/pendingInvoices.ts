import type { SupabaseClient } from '@supabase/supabase-js'
import { applyInvoiceToOrder } from './webhook'

export async function applyPendingOmieInvoices(supabase: SupabaseClient): Promise<{ processed: number; errors: number }> {
  let processed = 0
  let errors = 0

  const { data: pending, error: queryError } = await supabase.from('pending_omie_invoices').select('*')

  if (queryError) {
    return { processed: 0, errors: 1 }
  }

  for (const row of pending ?? []) {
    try {
      const { data: orderRow, error: orderQueryError } = await supabase
        .from('orders')
        .select('id')
        .eq('ml_order_id', row.ml_order_id)
        .maybeSingle()

      if (orderQueryError) {
        // A real DB error here must not be mistaken for "order not yet
        // synced" - that would silently drop a genuine failure instead of
        // counting it, the same defect the Task 4 fix round addressed in
        // webhook.ts's equivalent lookup.
        throw new Error(`Failed to look up order for ml_order_id ${row.ml_order_id}: ${orderQueryError.message}`)
      }

      if (!orderRow) continue // still not synced from Mercado Livre - try again next sweep, not an error

      await applyInvoiceToOrder(supabase, orderRow.id, {
        nfNumber: row.nf_number,
        nfeXmlUrl: row.nfe_xml_url,
        nfeDanfeUrl: row.nfe_danfe_url,
        ncmByProductCode: row.ncm_by_product_code,
      })

      const { error: deleteError } = await supabase.from('pending_omie_invoices').delete().eq('id', row.id)

      if (deleteError) {
        throw new Error(`Failed to delete pending Omie invoice ${row.id}: ${deleteError.message}`)
      }

      processed += 1
    } catch {
      errors += 1
    }
  }

  return { processed, errors }
}
