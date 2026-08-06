import type { SupabaseClient } from '@supabase/supabase-js'

export async function listProductCosts(supabase: SupabaseClient): Promise<Record<string, number>> {
  const { data, error } = await supabase.from('product_costs').select('product_code, cost')

  if (error) {
    console.error('Falha ao carregar custos de produto:', error)
    return {}
  }

  return Object.fromEntries(
    (data ?? []).map((row: { product_code: string; cost: number }) => [row.product_code, row.cost])
  )
}

export async function upsertProductCost(
  supabase: SupabaseClient,
  userId: string,
  productCode: string,
  cost: number
): Promise<{ error: boolean }> {
  const { error } = await supabase
    .from('product_costs')
    .upsert(
      { user_id: userId, product_code: productCode, cost, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,product_code' }
    )

  if (error) {
    console.error('Falha ao salvar custo de produto:', error)
    return { error: true }
  }

  return { error: false }
}
