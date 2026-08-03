import { NextResponse } from 'next/server'

export async function GET() {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ML_CLIENT_ID!,
    redirect_uri: process.env.ML_REDIRECT_URI!,
  })
  return NextResponse.redirect(`https://auth.mercadolivre.com.br/authorization?${params.toString()}`)
}
