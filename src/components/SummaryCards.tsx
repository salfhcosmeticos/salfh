import { formatCurrencyBRL } from '@/lib/format'

interface SummaryCardsProps {
  revenueTotal: number
  orderCount: number
  averageTicket: number
}

export function SummaryCards({ revenueTotal, orderCount, averageTicket }: SummaryCardsProps) {
  return (
    <section>
      <div>
        <h3>Faturamento</h3>
        <p>{formatCurrencyBRL(revenueTotal)}</p>
      </div>
      <div>
        <h3>Pedidos</h3>
        <p>{orderCount}</p>
      </div>
      <div>
        <h3>Ticket médio</h3>
        <p>{formatCurrencyBRL(averageTicket)}</p>
      </div>
    </section>
  )
}
