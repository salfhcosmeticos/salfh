'use client'

import { useMemo, useState } from 'react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  Tooltip,
  type TooltipProps,
  XAxis,
  YAxis,
} from 'recharts'
import { aggregateSales, type SalesGranularity, type SalesPoint } from '@/lib/sales/aggregate'
import { formatCurrencyBRL } from '@/lib/format'

interface SalesChartProps {
  orders: { orderDate: string; totalAmount: number }[]
}

const GRANULARITY_LABELS: Record<SalesGranularity, string> = {
  day: 'Dia',
  week: 'Semana',
  month: 'Mês',
  year: 'Ano',
}

// Validated categorical palette (dataviz skill, references/palette.md).
// Slots 1 and 2 (blue, orange) pass all six checks as an adjacent pair
// (CVD ΔE 24.7, normal-vision ΔE 33.6 — well above the 8 / 15 floors) —
// verified with scripts/validate_palette.js "#2a78d6,#eb6834" --mode light.
const COLOR_REVENUE = '#2a78d6' // categorical slot 1 (blue)
const COLOR_ORDERS = '#eb6834' // categorical slot 2 (orange)

// Chart chrome tokens (dataviz skill, references/palette.md), light surface.
const INK_PRIMARY = '#0b0b0b'
const INK_SECONDARY = '#52514e'
const INK_MUTED = '#898781'
const GRID_LINE = '#e1e0d9'
const AXIS_LINE = '#c3c2b7'
const SURFACE = '#fcfcfb'

function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null

  return (
    <div
      style={{
        background: SURFACE,
        border: `1px solid ${GRID_LINE}`,
        borderRadius: 4,
        padding: '8px 12px',
      }}
    >
      <p style={{ margin: 0, fontSize: 12, color: INK_SECONDARY }}>{label}</p>
      {payload.map((entry) => (
        <p
          key={entry.dataKey as string}
          style={{ margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}
        >
          <span style={{ display: 'inline-block', width: 12, height: 2, background: entry.color }} />
          <strong style={{ color: INK_PRIMARY }}>
            {entry.dataKey === 'revenue' ? formatCurrencyBRL(entry.value as number) : entry.value}
          </strong>
          <span style={{ color: INK_SECONDARY }}>{entry.name}</span>
        </p>
      ))}
    </div>
  )
}

export function SalesChart({ orders }: SalesChartProps) {
  const [granularity, setGranularity] = useState<SalesGranularity>('day')
  const data = useMemo<SalesPoint[]>(() => aggregateSales(orders, granularity), [orders, granularity])

  return (
    <section>
      <div role="group" aria-label="Granularidade do gráfico">
        {(Object.keys(GRANULARITY_LABELS) as SalesGranularity[]).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={granularity === option}
            onClick={() => setGranularity(option)}
          >
            {GRANULARITY_LABELS[option]}
          </button>
        ))}
      </div>
      <ComposedChart width={720} height={360} data={data}>
        <CartesianGrid stroke={GRID_LINE} strokeDasharray="0" vertical={false} />
        <XAxis
          dataKey="period"
          axisLine={{ stroke: AXIS_LINE }}
          tickLine={{ stroke: AXIS_LINE }}
          tick={{ fill: INK_MUTED, fontSize: 12 }}
        />
        <YAxis
          yAxisId="revenue"
          tickFormatter={(value) => formatCurrencyBRL(value)}
          axisLine={{ stroke: AXIS_LINE }}
          tickLine={{ stroke: AXIS_LINE }}
          tick={{ fill: INK_MUTED, fontSize: 12 }}
          label={{ value: 'Faturamento (R$)', angle: -90, position: 'insideLeft', fill: INK_MUTED, fontSize: 12 }}
        />
        <YAxis
          yAxisId="orders"
          orientation="right"
          allowDecimals={false}
          axisLine={{ stroke: AXIS_LINE }}
          tickLine={{ stroke: AXIS_LINE }}
          tick={{ fill: INK_MUTED, fontSize: 12 }}
          label={{ value: 'Pedidos', angle: 90, position: 'insideRight', fill: INK_MUTED, fontSize: 12 }}
        />
        <Tooltip content={<ChartTooltip />} />
        <Legend wrapperStyle={{ color: INK_SECONDARY, fontSize: 12 }} />
        <Bar yAxisId="revenue" dataKey="revenue" name="Faturamento" fill={COLOR_REVENUE} barSize={24} radius={[4, 4, 0, 0]} />
        <Line
          yAxisId="orders"
          dataKey="orderCount"
          name="Pedidos"
          type="monotone"
          stroke={COLOR_ORDERS}
          strokeWidth={2}
          dot={{ r: 4, fill: COLOR_ORDERS }}
        />
      </ComposedChart>
    </section>
  )
}
