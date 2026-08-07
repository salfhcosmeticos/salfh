import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const handleOmieWebhook = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ fake: true }),
}))
vi.mock('@/lib/omie/webhook', () => ({
  handleOmieWebhook: (...args: unknown[]) => handleOmieWebhook(...args),
}))

const { POST } = await import('./route')
const { NextRequest } = await import('next/server')

const PAYLOAD = { topic: 'NFe.NotaAutorizada', event: { id_pedido: 1 } }

function webhookRequest(url: string, body: unknown = PAYLOAD) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/webhooks/omie', () => {
  beforeEach(() => {
    handleOmieWebhook.mockReset()
    handleOmieWebhook.mockResolvedValue(undefined)
    process.env.OMIE_WEBHOOK_SECRET = 's3cret'
  })

  afterEach(() => {
    delete process.env.OMIE_WEBHOOK_SECRET
  })

  it('rejects a request with no secret and does no work', async () => {
    const response = await POST(webhookRequest('https://example.com/api/webhooks/omie?account=matriz'))
    expect(response.status).toBe(401)
    expect(handleOmieWebhook).not.toHaveBeenCalled()
  })

  it('rejects a request with the wrong secret', async () => {
    const response = await POST(webhookRequest('https://example.com/api/webhooks/omie?account=matriz&secret=wrong'))
    expect(response.status).toBe(401)
    expect(handleOmieWebhook).not.toHaveBeenCalled()
  })

  it('rejects everything when OMIE_WEBHOOK_SECRET is not configured', async () => {
    delete process.env.OMIE_WEBHOOK_SECRET
    const response = await POST(webhookRequest('https://example.com/api/webhooks/omie?account=matriz&secret=s3cret'))
    expect(response.status).toBe(401)
  })

  it('rejects a missing or invalid account param', async () => {
    const response = await POST(webhookRequest('https://example.com/api/webhooks/omie?secret=s3cret'))
    expect(response.status).toBe(400)
    expect(handleOmieWebhook).not.toHaveBeenCalled()

    const response2 = await POST(
      webhookRequest('https://example.com/api/webhooks/omie?secret=s3cret&account=headquarters')
    )
    expect(response2.status).toBe(400)
  })

  it('accepts a valid request and processes the payload against the right account', async () => {
    const response = await POST(webhookRequest('https://example.com/api/webhooks/omie?secret=s3cret&account=filial'))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ received: true })
    expect(handleOmieWebhook).toHaveBeenCalledWith({ fake: true }, 'filial', PAYLOAD)
  })

  it('rejects a body that is not valid JSON', async () => {
    const request = new (await import('next/server')).NextRequest(
      'https://example.com/api/webhooks/omie?secret=s3cret&account=matriz',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json' }
    )
    const response = await POST(request)
    expect(response.status).toBe(400)
    expect(handleOmieWebhook).not.toHaveBeenCalled()
  })

  it('acknowledges before webhook processing finishes and does not reject when it fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    handleOmieWebhook.mockRejectedValue(new Error('boom'))

    const response = await POST(webhookRequest('https://example.com/api/webhooks/omie?secret=s3cret&account=matriz'))

    expect(response.status).toBe(200)
    await Promise.resolve()
    consoleError.mockRestore()
  })
})
