import type { SupabaseClient } from '@supabase/supabase-js'

export async function listProductCosts(supabase: SupabaseClient): Promise<Record<string, number>> {
  const { data, error } = await supabase.from('product_costs').select('ml_item_id, cost')

  if (error) {
    console.error('Falha ao carregar custos de produto:', error)
    return {}
  }

  return Object.fromEntries(
    (data ?? []).map((row: { ml_item_id: string; cost: number }) => [row.ml_item_id, row.cost])
  )
}

export async function upsertProductCost(
  supabase: SupabaseClient,
  userId: string,
  mlItemId: string,
  cost: number
): Promise<{ error: boolean }> {
  const { error } = await supabase
    .from('product_costs')
    .upsert(
      { user_id: userId, ml_item_id: mlItemId, cost, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,ml_item_id' }
    )

  if (error) {
    console.error('Falha ao salvar custo de produto:', error)
    return { error: true }
  }

  return { error: false }
}
