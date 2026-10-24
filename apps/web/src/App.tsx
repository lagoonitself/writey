import type { Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { usePath } from './lib/router'
import { supabase, supabaseConfigured } from './lib/supabase'
import { Library } from './notebook/Library'
import { NotebookView } from './notebook/NotebookView'

export function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  if (!supabaseConfigured) {
    return (
      <Centered>
        <h1>Writey</h1>
        <p className="muted">
          Supabase isn't configured. Copy <code>apps/web/.env.example</code> to{' '}
          <code>.env.local</code> and fill it in.
        </p>
      </Centered>
    )
  }
  if (loading) return <Centered>Loading…</Centered>
  return session ? <Signed session={session} /> : <SignIn />
}

function Signed({ session }: { session: Session }) {
  const path = usePath()
  const notebookId = /^\/n\/([0-9a-f-]{36})$/i.exec(path)?.[1]
  return notebookId ? (
    <NotebookView key={notebookId} id={notebookId} />
  ) : (
    <Library session={session} />
  )
}

function SignIn() {
  const [error, setError] = useState<string | null>(null)
  const signIn = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      // Must match the Supabase redirect allow list, which holds origins only.
      options: { redirectTo: window.location.origin },
    })
    if (error) setError(error.message)
  }
  return (
    <Centered>
      <h1>Writey</h1>
      <p className="muted">Your notebook that writes back.</p>
      <button type="button" onClick={signIn}>
        Continue with Google
      </button>
      {error && <p className="error">{error}</p>}
    </Centered>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="centered">{children}</main>
}
