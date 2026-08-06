import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { syncOrdersInRange, type StoredMercadoLivreAccount } from '@/lib/mercadolivre/sync'

// Manually re-syncs a date range for the logged-in owner's own Mercado Livre
// account, reusing the same read path as the automatic backfill/reconciliation
// jobs. Exists so historical orders synced before a schema/field change (e.g.
// product_code) can be refreshed without waiting for a fresh 12-month backfill,
// which the owner explicitly wants to do in narrower date ranges at a time.
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 })
  }

  const { data: accountRow, error: accountError } = await supabase
    .from('marketplace_accounts')
    .select('*')
    .eq('marketplace', 'mercado_livre')
    .maybeSingle()

  if (accountError || !accountRow) {
    return NextResponse.json({ error: 'Conta do Mercado Livre não encontrada.' }, { status: 404 })
  }

  const body = await request.json().catch(() => ({}))
  const fromDate = typeof body.fromDate === 'string' ? body.fromDate : null
  if (!fromDate) {
    return NextResponse.json({ error: 'Informe fromDate.' }, { status: 400 })
  }

  const account: StoredMercadoLivreAccount = {
    id: accountRow.id,
    userId: accountRow.user_id,
    mlUserId: accountRow.ml_user_id,
    accessToken: accountRow.access_token,
    refreshToken: accountRow.refresh_token,
    tokenExpiresAt: accountRow.token_expires_at,
  }

  const result = await syncOrdersInRange(supabase, account, fromDate, new Date().toISOString(), 'backfill')

  return NextResponse.json(result)
}
