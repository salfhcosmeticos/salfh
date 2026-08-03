import { describe, it, expect } from 'vitest'
import { getRedirectPathForSession } from './session'

describe('getRedirectPathForSession', () => {
  it('sends unauthenticated users to /login', () => {
    expect(getRedirectPathForSession(false, '/')).toBe('/login')
  })

  it('does not redirect unauthenticated users already on /login', () => {
    expect(getRedirectPathForSession(false, '/login')).toBeNull()
  })

  it('sends authenticated users away from /login', () => {
    expect(getRedirectPathForSession(true, '/login')).toBe('/')
  })

  it('does not redirect authenticated users elsewhere', () => {
    expect(getRedirectPathForSession(true, '/')).toBeNull()
  })
})
