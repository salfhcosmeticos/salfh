'use client'

import { useState } from 'react'
import { createBrowserSupabaseClient } from '@/lib/supabase/browser'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const supabase = createBrowserSupabaseClient()
    await supabase.auth.signInWithOtp({ email })
    setSent(true)
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
    </main>
  )
}
