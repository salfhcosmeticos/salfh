import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRedirectPathForSession } from '@/lib/auth/session'
import { ConnectMercadoLivreButton } from '@/components/ConnectMercadoLivreButton'

export default async function HomePage() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  const redirectPath = getRedirectPathForSession(Boolean(user), '/')
  if (redirectPath) {
    redirect(redirectPath)
  }

  return (
    <main>
      Dashboard de Vendas
      <ConnectMercadoLivreButton />
    </main>
  )
}
