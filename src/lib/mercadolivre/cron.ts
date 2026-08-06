import cron from 'node-cron'
import { createServiceClient } from '@/lib/supabase/server'
import { reconcileRecentOrders, retryPendingFiscalDocuments, type StoredMercadoLivreAccount } from './sync'

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
      await retryPendingFiscalDocuments(supabase, account)
    }
  })
}
