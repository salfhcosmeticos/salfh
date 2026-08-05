'use client'

import { useState } from 'react'
import { formatCurrencyBRL } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Badge } from '@/components/ui/badge'

interface OrderRow {
  id: string
  status: string
  totalAmount: number
  orderDate: string
  itemsSummary: string
}

type FilterMode = 'all' | 'hideCancelled'

const FILTER_LABELS: Record<FilterMode, string> = {
  all: 'Todos',
  hideCancelled: 'Ocultar cancelados',
}

function StatusBadge({ status }: { status: string }) {
  const variant = status === 'cancelled' ? 'destructive' : status === 'refunded' ? 'outline' : 'default'
  return <Badge variant={variant}>{status}</Badge>
}

export function OrdersTable({ orders }: { orders: OrderRow[] }) {
  const [filterMode, setFilterMode] = useState<FilterMode>('all')

  const displayedOrders = filterMode === 'hideCancelled' ? orders.filter((order) => order.status !== 'cancelled') : orders

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium">Pedidos</CardTitle>
        <ToggleGroup
          type="single"
          value={filterMode}
          onValueChange={(value) => value && setFilterMode(value as FilterMode)}
          aria-label="Filtrar pedidos"
        >
          {(Object.keys(FILTER_LABELS) as FilterMode[]).map((option) => (
            <ToggleGroupItem key={option} value={option} aria-label={FILTER_LABELS[option]}>
              {FILTER_LABELS[option]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead>Produto</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Valor</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {displayedOrders.map((order) => (
              <TableRow key={order.id}>
                <TableCell>{new Date(order.orderDate).toLocaleDateString('pt-BR')}</TableCell>
                <TableCell>{order.itemsSummary}</TableCell>
                <TableCell>
                  <StatusBadge status={order.status} />
                </TableCell>
                <TableCell className="text-right">{formatCurrencyBRL(order.totalAmount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
