import { formatCurrencyBRL } from '@/lib/format'

interface OrderRow {
  id: string
  status: string
  totalAmount: number
  orderDate: string
  itemsSummary: string
}

export function OrdersTable({ orders }: { orders: OrderRow[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Data</th>
          <th>Produto</th>
          <th>Status</th>
          <th>Valor</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => (
          <tr key={order.id}>
            <td>{new Date(order.orderDate).toLocaleDateString('pt-BR')}</td>
            <td>{order.itemsSummary}</td>
            <td>{order.status}</td>
            <td>{formatCurrencyBRL(order.totalAmount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
