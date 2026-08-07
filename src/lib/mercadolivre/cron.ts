import cron from 'node-cron'
import { createServiceClient } from '@/lib/supabase/server'
import { reconcileRecentOrders, type StoredMercadoLivreAccount } from './sync'
import { applyPendingOmieInvoices } from '@/lib/omie/pendingInvoices'

export function startReconciliationCron() {
  cron.schedule('*/15 * * * *', async () => {
    const supabase = createServiceClient()
    const { data: accounts } = await supabase
      .from('marketplace_accounts')
      .select('*')
      .eq('marketplace', 'mercado_livre')

    for (const row of accounts ?? []) {
      const account: StoredMercadoLivreAccount = {
        id: row.id,
        userId: row.user_id,
        mlUserId: row.ml_user_id,
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        tokenExpiresAt: row.token_expires_at,
      }
      await reconcileRecentOrders(supabase, account, 2)
    }

    // Account-agnostic (matches by ml_order_id, not tied to a specific
    // marketplace_accounts row) - runs once per tick, not once per account.
    await applyPendingOmieInvoices(supabase)
  })
}
