import Link from 'next/link'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { ConnectMercadoLivreButton } from '@/components/ConnectMercadoLivreButton'
import { VendasDashboardClient } from '@/components/VendasDashboardClient'
import { fetchDashboardOrders } from '@/lib/sales/fetchOrders'

export default async function HomePage() {
  const supabase = await createServerSupabaseClient()

  // The login gate is deliberately off for now, so an anonymous visitor just
  // hits RLS and gets zero rows — indistinguishable from "no orders yet"
  // unless we say so explicitly. This is not a redirect: the page still
  // renders, it just renders a different (honest) empty state.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold">Dashboard de Vendas</h1>
        <p className="text-sm text-muted-foreground">Faça login para ver seus dados.</p>
        <Link href="/login" className="text-sm underline underline-offset-4">
          Entrar
        </Link>
      </div>
    )
  }

  const { rows, error } = await fetchDashboardOrders(supabase)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Dashboard de Vendas</h1>
        <ConnectMercadoLivreButton />
      </div>
      {error ? <p className="text-sm text-destructive">Não foi possível carregar seus pedidos. Tente novamente.</p> : null}
      <VendasDashboardClient initialOrders={rows} />
    </div>
  )
}
