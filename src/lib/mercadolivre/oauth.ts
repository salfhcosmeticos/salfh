const ML_TOKEN_URL = 'https://api.mercadolibre.com/oauth/token'

export interface MercadoLivreTokens {
  accessToken: string
  refreshToken: string
  expiresAt: string
  mlUserId: number
}

interface MercadoLivreTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  user_id: number
}

function toTokens(response: MercadoLivreTokenResponse): MercadoLivreTokens {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: new Date(Date.now() + response.expires_in * 1000).toISOString(),
    mlUserId: response.user_id,
  }
}

async function requestToken(body: Record<string, string>): Promise<MercadoLivreTokens> {
  const response = await fetch(ML_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  if (!response.ok) {
    throw new Error(`Mercado Livre token request failed: ${response.status}`)
  }
  return toTokens(await response.json())
}

export async function exchangeCodeForToken(code: string): Promise<MercadoLivreTokens> {
  return requestToken({
    grant_type: 'authorization_code',
    client_id: process.env.ML_CLIENT_ID!,
    client_secret: process.env.ML_CLIENT_SECRET!,
    code,
    redirect_uri: process.env.ML_REDIRECT_URI!,
  })
}

export async function refreshMercadoLivreToken(refreshToken: string): Promise<MercadoLivreTokens> {
  return requestToken({
    grant_type: 'refresh_token',
    client_id: process.env.ML_CLIENT_ID!,
    client_secret: process.env.ML_CLIENT_SECRET!,
    refresh_token: refreshToken,
  })
}
