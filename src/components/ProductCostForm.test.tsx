import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ProductCostForm } from './ProductCostForm'
import * as browserClient from '@/lib/supabase/browser'
import * as productCostsModule from '@/lib/margin/productCosts'

describe('ProductCostForm', () => {
  beforeEach(() => {
    vi.spyOn(browserClient, 'createBrowserSupabaseClient').mockReturnValue({} as never)
  })

  it('saves the SKU and cost typed into the form', async () => {
    const upsertSpy = vi.spyOn(productCostsModule, 'upsertProductCost').mockResolvedValue({ error: false })

    render(<ProductCostForm userId="user-1" />)

    fireEvent.change(screen.getByLabelText('SKU do produto'), { target: { value: 'SF9004' } })
    fireEvent.change(screen.getByLabelText('Custo (R$)'), { target: { value: '45.50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar custo' }))

    await waitFor(() => {
      expect(upsertSpy).toHaveBeenCalledWith(expect.anything(), 'user-1', 'SF9004', 45.5)
    })
    expect(screen.getByText('Custo salvo.')).toBeTruthy()
  })

  it('shows an error message when saving fails', async () => {
    vi.spyOn(productCostsModule, 'upsertProductCost').mockResolvedValue({ error: true })

    render(<ProductCostForm userId="user-1" />)

    fireEvent.change(screen.getByLabelText('SKU do produto'), { target: { value: 'SF9004' } })
    fireEvent.change(screen.getByLabelText('Custo (R$)'), { target: { value: '45.50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar custo' }))

    await waitFor(() => {
      expect(screen.getByText('Não foi possível salvar o custo. Tente novamente.')).toBeTruthy()
    })
  })
})
