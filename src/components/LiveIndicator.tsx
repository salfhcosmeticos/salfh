'use client'

import { useEffect, useState } from 'react'

interface LiveIndicatorProps {
  isLive: boolean
  lastUpdatedAt: Date | null
}

function formatRelativeUpdate(lastUpdatedAt: Date | null, now: Date): string {
  if (!lastUpdatedAt) return 'aguardando atualização'
  const minutes = Math.floor((now.getTime() - lastUpdatedAt.getTime()) / 60000)
  return minutes < 1 ? 'atualizado agora' : `atualizado há ${minutes}m`
}

export function LiveIndicator({ isLive, lastUpdatedAt }: LiveIndicatorProps) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className={`h-2 w-2 rounded-full ${isLive ? 'bg-green-500' : 'bg-gray-400'}`} aria-hidden="true" />
      <span>
        {isLive ? 'Ao vivo' : 'Offline'} · {formatRelativeUpdate(lastUpdatedAt, now)}
      </span>
      <span data-testid="last-updated" className="sr-only">
        {lastUpdatedAt?.toISOString() ?? ''}
      </span>
    </div>
  )
}
