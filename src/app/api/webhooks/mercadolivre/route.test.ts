import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const handleMercadoLivreWebhook = vi.fn()

// Mocked so the test never pulls in `server-only` (which throws outside an RSC
// build) and never constructs a real Supabase client.
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ fake: true }),
}))
vi.mock('@/lib/mercadolivre/sync', () => ({
  handleMercadoLivreWebhook: (...args: unknown[]) => handleMercadoLivreWebhook(...args),
}))

const { POST } = await import('./route')
const { NextRequest } = await import('next/server')

const PAYLOAD = { topic: 'orders_v2', resource: '/orders/555', user_id: 999 }

function webhookRequest(url: string, body: unknown = PAYLOAD) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/webhooks/mercadolivre', () => {
  beforeEach(() => {
    handleMercadoLivreWebhook.mockReset()
    handleMercadoLivreWebhook.mockResolvedValue(undefined)
    process.env.ML_WEBHOOK_SECRET = 's3cret'
  })

  afterEach(() => {
    delete process.env.ML_WEBHOOK_SECRET
  })

  it('rejects a request with no secret and does no work', async () => {
    const response = await POST(webhookRequest('https://example.com/api/webhooks/mercadolivre'))
    expect(response.status).toBe(401)
    expect(handleMercadoLivreWebhook).not.toHaveBeenCalled()
  })

  it('rejects a request with the wrong secret and does no work', async () => {
    const response = await POST(
      webhookRequest('https://example.com/api/webhooks/mercadolivre?secret=wrong')
    )
    expect(response.status).toBe(401)
    expect(handleMercadoLivreWebhook).not.toHaveBeenCalled()
  })

  it('rejects everything when ML_WEBHOOK_SECRET is not configured', async () => {
    delete process.env.ML_WEBHOOK_SECRET
    const response = await POST(
      webhookRequest('https://example.com/api/webhooks/mercadolivre?secret=s3cret')
    )
    expect(response.status).toBe(401)
    expect(handleMercadoLivreWebhook).not.toHaveBeenCalled()
  })

  it('accepts a request with the right secret and processes the payload', async () => {
    const response = await POST(
      webhookRequest('https://example.com/api/webhooks/mercadolivre?secret=s3cret')
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ received: true })
    expect(handleMercadoLivreWebhook).toHaveBeenCalledWith({ fake: true }, PAYLOAD)
  })

  it('rejects a body that is not valid JSON', async () => {
    const request = new NextRequest('https://example.com/api/webhooks/mercadolivre?secret=s3cret', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })
    const response = await POST(request)
    expect(response.status).toBe(400)
    expect(handleMercadoLivreWebhook).not.toHaveBeenCalled()
  })

  it('acknowledges before the webhook processing finishes', async () => {
    let releaseProcessing: () => void = () => {}
    handleMercadoLivreWebhook.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseProcessing = resolve
        })
    )

    const response = await POST(
      webhookRequest('https://example.com/api/webhooks/mercadolivre?secret=s3cret')
    )

    // The ACK is already available while processing is still pending — ML
    // retries deliveries it considers slow, so this must not block on the work.
    expect(response.status).toBe(200)
    expect(handleMercadoLivreWebhook).toHaveBeenCalledTimes(1)
    releaseProcessing()
  })

  it('does not reject the request when webhook processing fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    handleMercadoLivreWebhook.mockRejectedValue(new Error('boom'))

    const response = await POST(
      webhookRequest('https://example.com/api/webhooks/mercadolivre?secret=s3cret')
    )

    expect(response.status).toBe(200)
    await Promise.resolve()
    consoleError.mockRestore()
  })
})
