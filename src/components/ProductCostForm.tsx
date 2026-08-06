'use client'

import { useState } from 'react'
import { createBrowserSupabaseClient } from '@/lib/supabase/browser'
import { upsertProductCost } from '@/lib/margin/productCosts'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

export function ProductCostForm({ userId }: { userId: string }) {
  const [productCode, setProductCode] = useState('')
  const [cost, setCost] = useState('')
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle')

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const supabase = createBrowserSupabaseClient()
    const parsedCost = Number(cost)
    const result = await upsertProductCost(supabase, userId, productCode, parsedCost)
    setStatus(result.error ? 'error' : 'saved')
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <label htmlFor="product-code" className="text-sm">
          SKU do produto
        </label>
        <Input id="product-code" value={productCode} onChange={(event) => setProductCode(event.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="cost" className="text-sm">
          Custo (R$)
        </label>
        <Input id="cost" type="number" step="0.01" value={cost} onChange={(event) => setCost(event.target.value)} />
      </div>
      <Button type="submit">Salvar custo</Button>
      {status === 'saved' ? <p className="text-sm text-muted-foreground">Custo salvo.</p> : null}
      {status === 'error' ? <p className="text-sm text-destructive">Não foi possível salvar o custo. Tente novamente.</p> : null}
    </form>
  )
}
