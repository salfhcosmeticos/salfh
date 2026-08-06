import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AppSidebar } from './AppSidebar'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'

// jsdom does not implement window.matchMedia. SidebarProvider's internal
// useIsMobile hook calls it on mount, so it must be stubbed for this
// component to render in tests.
beforeAll(() => {
  window.matchMedia =
    window.matchMedia ||
    ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }))
})

describe('AppSidebar', () => {
  it('renders Vendas and Margem de contribuição as real links and every other item as disabled with no href', () => {
    render(
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
      </TooltipProvider>
    )

    const vendasLink = screen.getByRole('link', { name: /Vendas/ })
    expect(vendasLink.getAttribute('href')).toBe('/')

    const margemLink = screen.getByRole('link', { name: /Margem de contribuição/ })
    expect(margemLink.getAttribute('href')).toBe('/margem-contribuicao')

    for (const label of ['Produtos', 'Estoque', 'Anúncios', 'Financeiro', 'Integrações', 'Configurações']) {
      expect(screen.queryByRole('link', { name: new RegExp(label) })).toBeNull()
      expect(screen.getByText(new RegExp(label))).toBeTruthy()
    }
  })
})
