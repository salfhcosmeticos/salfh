import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { handleMercadoLivreWebhook } from '@/lib/mercadolivre/sync'

export async function POST(request: NextRequest) {
  // Mercado Livre does not sign its notifications, but it does let you register
  // an arbitrary callback URL — so the shared secret simply lives in the URL
  // configured in the DevCenter (…/api/webhooks/mercadolivre?secret=…). Without
  // it, anyone who discovers this endpoint can burn our ML rate limit and write
  // unbounded sync_runs rows.
  const expectedSecret = process.env.ML_WEBHOOK_SECRET
  if (!expectedSecret || request.nextUrl.searchParams.get('secret') !== expectedSecret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let payload
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (!payload || typeof payload !== 'object') {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 })
  }

  // Acknowledge immediately: ML expects a fast ACK and retries deliveries it
  // considers slow or failed, and sustained slow ACKs can get the notification
  // URL disabled entirely. handleMercadoLivreWebhook has its own internal
  // try/catch and records a sync_runs row, so nothing is lost by not awaiting.
  void handleMercadoLivreWebhook(createServiceClient(), payload).catch((error) => {
    console.error('Webhook processing failed:', error)
  })

  return NextResponse.json({ received: true })
}
