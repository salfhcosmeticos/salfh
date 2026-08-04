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

  const tokens = await exchangeCodeForToken(code)

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

  await backfillOrders(
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
  )

  return NextResponse.redirect(new URL('/?ml_connected=true', request.url))
}
