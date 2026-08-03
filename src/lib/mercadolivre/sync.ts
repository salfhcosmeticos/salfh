import type { SupabaseClient } from '@supabase/supabase-js'
import type { MercadoLivreOrder } from './client'

export interface StoredMercadoLivreAccount {
  id: string
  userId: string
  mlUserId: number
  accessToken: string
  refreshToken: string
  tokenExpiresAt: string
}

export async function upsertOrder(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  order: MercadoLivreOrder
): Promise<void> {
  const { data: orderRow, error: orderError } = await supabase
    .from('orders')
    .upsert(
      {
        account_id: accountId,
        user_id: userId,
        ml_order_id: order.id,
        status: order.status,
        total_amount: order.totalAmount,
        currency_id: order.currencyId,
        order_date: order.dateCreated,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,ml_order_id' }
    )
    .select('id')
    .single()

  if (orderError) {
    throw new Error(`Falha ao gravar pedido ${order.id}: ${orderError.message}`)
  }

  if (order.items.length === 0) {
    return
  }

  const itemRows = order.items.map((item) => ({
    order_id: orderRow.id,
    user_id: userId,
    ml_item_id: item.mlItemId,
    title: item.title,
    quantity: item.quantity,
    unit_price: item.unitPrice,
  }))

  const { error: itemsError } = await supabase
    .from('order_items')
    .upsert(itemRows, { onConflict: 'order_id,ml_item_id' })

  if (itemsError) {
    throw new Error(`Falha ao gravar itens do pedido ${order.id}: ${itemsError.message}`)
  }
}
