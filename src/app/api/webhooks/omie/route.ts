import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { handleOmieWebhook } from '@/lib/omie/webhook'
import type { OmieAccount } from '@/lib/omie/client'

export async function POST(request: NextRequest) {
  // Same pattern as the Mercado Livre webhook: Omie's webhook config lets us
  // register an arbitrary URL, so the shared secret lives in the query
  // string configured in the Developer Portal.
  const expectedSecret = process.env.OMIE_WEBHOOK_SECRET
  if (!expectedSecret || request.nextUrl.searchParams.get('secret') !== expectedSecret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Matriz and filial are two separate Omie accounts/apps, each with its
  // own webhook registration pointed at this same route with a different
  // `account` value - that's how we know which app's credentials to use,
  // rather than trusting the payload's own empresa_cnpj field.
  const account = request.nextUrl.searchParams.get('account')
  if (account !== 'matriz' && account !== 'filial') {
    return NextResponse.json({ error: 'invalid_account' }, { status: 400 })
  }

  let payload
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  // Acknowledge immediately, same rationale as the Mercado Livre webhook
  // route: handleOmieWebhook has its own error handling, and a slow ACK
  // risks the webhook being considered failed or disabled upstream.
  void handleOmieWebhook(createServiceClient(), account as OmieAccount, payload).catch((error) => {
    console.error('Omie webhook processing failed:', error)
  })

  return NextResponse.json({ received: true })
}
