'use client'

import { useState } from 'react'
import { createBrowserSupabaseClient } from '@/lib/supabase/browser'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      const supabase = createBrowserSupabaseClient()
      const { error: signInError } = await supabase.auth.signInWithOtp({ email })
      if (signInError) {
        setError(signInError.message)
        return
      }
      setSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro inesperado ao enviar o link de acesso.')
    }
  }

  if (sent) {
    return <main>Enviamos um link de acesso para {email}. Confira seu e-mail.</main>
  }

  return (
    <main>
      <form onSubmit={handleSubmit}>
        <label htmlFor="email">E-mail</label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit">Entrar</button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
    </main>
  )
}
