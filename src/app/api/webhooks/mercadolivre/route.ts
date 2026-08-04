import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { handleMercadoLivreWebhook } from '@/lib/mercadolivre/sync'

export async function POST(request: NextRequest) {
  const payload = await request.json()
  const supabase = createServiceClient()
  await handleMercadoLivreWebhook(supabase, payload)
  return NextResponse.json({ received: true })
}
