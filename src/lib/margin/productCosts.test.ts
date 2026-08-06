import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { listProductCosts, upsertProductCost } from './productCosts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('listProductCosts', () => {
  it('returns a map of product_code to cost', async () => {
    const supabase = {
      from: () => ({
        select: () =>
          Promise.resolve({
            data: [
              { product_code: 'SF9004', cost: 45.5 },
              { product_code: 'SF9846', cost: 20 },
            ],
            error: null,
          }),
      }),
    } as unknown as SupabaseClient

    expect(await listProductCosts(supabase)).toEqual({ SF9004: 45.5, SF9846: 20 })
  })

  it('returns an empty map when the query fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = {
      from: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }),
    } as unknown as SupabaseClient

    expect(await listProductCosts(supabase)).toEqual({})
  })
})

describe('upsertProductCost', () => {
  it('upserts a cost row scoped to the user and item', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: () => ({ upsert }) } as unknown as SupabaseClient

    const result = await upsertProductCost(supabase, 'user-1', 'SF9004', 45.5)

    expect(result).toEqual({ error: false })
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1', product_code: 'SF9004', cost: 45.5 }),
      { onConflict: 'user_id,product_code' }
    )
  })

  it('returns error: true when the upsert fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = {
      from: () => ({ upsert: () => Promise.resolve({ error: { message: 'boom' } }) }),
    } as unknown as SupabaseClient

    expect(await upsertProductCost(supabase, 'user-1', 'SF9004', 45.5)).toEqual({ error: true })
  })
})
