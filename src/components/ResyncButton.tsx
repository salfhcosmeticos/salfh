'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ResyncButton() {
  const [fromDate, setFromDate] = useState('2026-07-01')
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<{ processed: number; errors: number } | null>(null)

  async function handleClick() {
    setStatus('running')
    setResult(null)
    try {
      const response = await fetch('/api/mercadolivre/resync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromDate: new Date(fromDate).toISOString() }),
      })
      if (!response.ok) {
        setStatus('error')
        return
      }
      const data = await response.json()
      setResult(data)
      setStatus('done')
    } catch {
      setStatus('error')
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="resync-from-date" className="text-sm">
          Ressincronizar pedidos desde
        </label>
        <Input
          id="resync-from-date"
          type="date"
          value={fromDate}
          onChange={(event) => setFromDate(event.target.value)}
        />
      </div>
      <Button type="button" onClick={handleClick} disabled={status === 'running'}>
        {status === 'running' ? 'Sincronizando...' : 'Ressincronizar'}
      </Button>
      {status === 'done' && result ? (
        <p className="text-sm text-muted-foreground">
          {result.processed} pedido(s) processado(s), {result.errors} erro(s).
        </p>
      ) : null}
      {status === 'error' ? <p className="text-sm text-destructive">Falha ao ressincronizar. Tente novamente.</p> : null}
    </div>
  )
}
