import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LiveIndicator } from './LiveIndicator'

describe('LiveIndicator', () => {
  it('shows Ao vivo and the exact last-updated timestamp when live', () => {
    const lastUpdatedAt = new Date('2026-08-04T12:00:00.000Z')
    render(<LiveIndicator isLive={true} lastUpdatedAt={lastUpdatedAt} />)

    expect(screen.getByText(/Ao vivo/)).toBeTruthy()
    expect(screen.getByTestId('last-updated').textContent).toBe(lastUpdatedAt.toISOString())
  })

  it('shows Offline and no timestamp yet when nothing has loaded', () => {
    render(<LiveIndicator isLive={false} lastUpdatedAt={null} />)

    expect(screen.getByText(/Offline/)).toBeTruthy()
    expect(screen.getByTestId('last-updated').textContent).toBe('')
  })
})
