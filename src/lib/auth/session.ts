export function getRedirectPathForSession(hasSession: boolean, pathname: string): string | null {
  const isLoginPage = pathname === '/login'
  if (!hasSession && !isLoginPage) return '/login'
  if (hasSession && isLoginPage) return '/'
  return null
}
