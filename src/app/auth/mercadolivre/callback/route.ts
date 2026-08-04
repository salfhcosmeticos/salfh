import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForToken } from '@/lib/mercadolivre/oauth'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  if (!code) {
    return NextResponse.redirect(new URL('/?ml_error=missing_code', request.url))
  }

  const supabaseAuth = await createServerSupabaseClient()
  const { data: { user } } = await supabaseAuth.auth.getUser()
  if (!user) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  const tokens = await exchangeCodeForToken(code)
  const supabase = createServiceClient()

  await supabase.from('marketplace_accounts').upsert(
    {
      user_id: user.id,
      marketplace: 'mercado_livre',
      ml_user_id: tokens.mlUserId,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_expires_at: tokens.expiresAt,
    },
    { onConflict: 'user_id,marketplace,ml_user_id' }
  )

  return NextResponse.redirect(new URL('/?ml_connected=true', request.url))
}
