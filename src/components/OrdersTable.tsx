'use client'

import { useState } from 'react'
import { formatCurrencyBRL } from '@/lib/format'

interface OrderRow {
  id: string
  status: string
  totalAmount: number
  orderDate: string
  itemsSummary: string
}

const FILTER_LABELS: Record<'all' | 'hideCancelled', string> = {
  all: 'Todos',
  hideCancelled: 'Ocultar cancelados',
}

export function OrdersTable({ orders }: { orders: OrderRow[] }) {
  const [filterMode, setFilterMode] = useState<'all' | 'hideCancelled'>('all')

  const displayedOrders = filterMode === 'hideCancelled' ? orders.filter((order) => order.status !== 'cancelled') : orders

  return (
    <section>
      <div role="group" aria-label="Filtrar pedidos">
        {(Object.keys(FILTER_LABELS) as Array<'all' | 'hideCancelled'>).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={filterMode === option}
            onClick={() => setFilterMode(option)}
          >
            {FILTER_LABELS[option]}
          </button>
        ))}
      </div>
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
          {displayedOrders.map((order) => (
            <tr key={order.id}>
              <td>{new Date(order.orderDate).toLocaleDateString('pt-BR')}</td>
              <td>{order.itemsSummary}</td>
              <td>{order.status}</td>
              <td>{formatCurrencyBRL(order.totalAmount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
