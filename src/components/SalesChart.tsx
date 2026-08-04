'use client'

import { useMemo, useState } from 'react'
import { Bar, CartesianGrid, ComposedChart, Tooltip, type TooltipProps, XAxis, YAxis } from 'recharts'
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
// Single series (revenue) → slot 1 (blue). Order count was dropped from
// this chart (owner decision, see task-11-report.md) in favor of a single
// left-axis bar chart; the total is already shown in SummaryCards above.
const COLOR_REVENUE = '#2a78d6' // categorical slot 1 (blue)

// Chart chrome tokens (dataviz skill, references/palette.md), light surface.
const INK_PRIMARY = '#0b0b0b'
const INK_SECONDARY = '#52514e'
const INK_MUTED = '#898781'
const GRID_LINE = '#e1e0d9'
const AXIS_LINE = '#c3c2b7'
const SURFACE = '#fcfcfb'

function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null

  const revenue = payload.find((entry) => entry.dataKey === 'revenue')
  if (!revenue) return null

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
      <p style={{ margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
        <span style={{ display: 'inline-block', width: 12, height: 2, background: revenue.color }} />
        <strong style={{ color: INK_PRIMARY }}>{formatCurrencyBRL(revenue.value as number)}</strong>
        <span style={{ color: INK_SECONDARY }}>{revenue.name}</span>
      </p>
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
        <Tooltip content={<ChartTooltip />} />
        <Bar yAxisId="revenue" dataKey="revenue" name="Faturamento" fill={COLOR_REVENUE} barSize={24} radius={[4, 4, 0, 0]} />
      </ComposedChart>
    </section>
  )
}
