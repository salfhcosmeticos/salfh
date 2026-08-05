import { ArrowDown, ArrowUp } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatCurrencyBRL } from '@/lib/format'
import type { PeriodComparison, RevenueSummary } from '@/lib/sales/aggregate'

function ChangeBadge({ changePct }: { changePct: PeriodComparison['changePct'] }) {
  if (changePct === null) {
    return <Badge variant="secondary">novo</Badge>
  }
  const isPositive = changePct >= 0
  return (
    <Badge variant={isPositive ? 'default' : 'destructive'} className="gap-1">
      {isPositive ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
      {Math.abs(changePct).toFixed(1)}%
    </Badge>
  )
}

function PeriodCard({ title, comparison }: { title: string; comparison: PeriodComparison }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <ChangeBadge changePct={comparison.changePct} />
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold">{formatCurrencyBRL(comparison.current)}</p>
      </CardContent>
    </Card>
  )
}

export function SummaryCards({ summary }: { summary: RevenueSummary }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Total</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold">{formatCurrencyBRL(summary.total)}</p>
        </CardContent>
      </Card>
      <PeriodCard title="Hoje" comparison={summary.today} />
      <PeriodCard title="Semana" comparison={summary.week} />
      <PeriodCard title="Mês" comparison={summary.month} />
    </div>
  )
}
