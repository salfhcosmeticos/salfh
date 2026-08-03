import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { exchangeCodeForToken, refreshMercadoLivreToken } from './oauth'

const originalFetch = global.fetch

beforeEach(() => {
  process.env.ML_CLIENT_ID = 'test-client-id'
  process.env.ML_CLIENT_SECRET = 'test-secret'
  process.env.ML_REDIRECT_URI = 'https://salfhcosmeticos.tech/auth/mercadolivre/callback'
})

afterEach(() => {
  global.fetch = originalFetch
})

describe('exchangeCodeForToken', () => {
  it('converts a ML token response into MercadoLivreTokens', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-123',
        refresh_token: 'refresh-123',
        expires_in: 21600,
        user_id: 999,
      }),
    }) as unknown as typeof fetch

    const tokens = await exchangeCodeForToken('some-code')

    expect(tokens.accessToken).toBe('access-123')
    expect(tokens.refreshToken).toBe('refresh-123')
    expect(tokens.mlUserId).toBe(999)
    expect(new Date(tokens.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('throws when the API responds with an error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400 }) as unknown as typeof fetch
    await expect(exchangeCodeForToken('bad-code')).rejects.toThrow()
  })
})

describe('refreshMercadoLivreToken', () => {
  it('returns fresh tokens', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-456',
        refresh_token: 'refresh-456',
        expires_in: 21600,
        user_id: 999,
      }),
    }) as unknown as typeof fetch

    const tokens = await refreshMercadoLivreToken('old-refresh-token')
    expect(tokens.accessToken).toBe('access-456')
  })
})
