import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForToken } from '@/lib/mercadolivre/oauth'
import { createServiceClient } from '@/lib/supabase/server'
import { backfillOrders } from '@/lib/mercadolivre/sync'

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  if (!code) {
    return NextResponse.redirect(new URL('/?ml_error=missing_code', request.url))
  }

  const supabase = createServiceClient()
  const { data: usersPage, error: usersError } = await supabase.auth.admin.listUsers()
  const owner = usersPage?.users[0]
  if (usersError || !owner) {
    return NextResponse.redirect(new URL('/?ml_error=no_owner_user', request.url))
  }

  // A reused/expired code, a redirect_uri mismatch or an ML outage all surface
  // here as a thrown error. Without this guard they become a raw 500 instead of
  // the same friendly error redirect used by every other failure branch above.
  let tokens
  try {
    tokens = await exchangeCodeForToken(code)
  } catch (error) {
    console.error('Mercado Livre token exchange failed:', error)
    return NextResponse.redirect(new URL('/?ml_error=token_exchange_failed', request.url))
  }

  const { data: accountRow, error: accountError } = await supabase
    .from('marketplace_accounts')
    .upsert(
      {
        user_id: owner.id,
        marketplace: 'mercado_livre',
        ml_user_id: tokens.mlUserId,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_expires_at: tokens.expiresAt,
      },
      { onConflict: 'user_id,marketplace,ml_user_id' }
    )
    .select('id')
    .single()

  if (accountError || !accountRow) {
    return NextResponse.redirect(new URL('/?ml_error=save_failed', request.url))
  }

  // Fire-and-forget: a 12-month backfill pages at 50 orders/request with a
  // per-order upsert, which can run for minutes — long enough for a reverse
  // proxy to time out the redirect and turn a successful connection into a
  // user-facing error. The account row is already saved, and backfillOrders
  // records its own sync_runs row with success/failure, so the audit trail
  // survives even though this route no longer waits for it.
  void backfillOrders(
    supabase,
    {
      id: accountRow.id,
      userId: owner.id,
      mlUserId: tokens.mlUserId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.expiresAt,
    },
    12
  ).catch((error) => {
    console.error('Mercado Livre backfill failed after connecting account:', error)
  })

  return NextResponse.redirect(new URL('/?ml_connected=true', request.url))
}
