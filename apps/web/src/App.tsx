import type { Session } from '@supabase/supabase-js'
import type { MeResponse } from '@writey/shared'
import { useEffect, useState } from 'react'
import { api } from './lib/api'
import { supabase, supabaseConfigured } from './lib/supabase'

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
  return session ? <Home session={session} /> : <SignIn />
}

function SignIn() {
  const [error, setError] = useState<string | null>(null)
  const signIn = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
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

function Home({ session }: { session: Session }) {
  const [me, setMe] = useState<MeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<MeResponse>('/me')
      .then(setMe)
      .catch((e: Error) => setError(e.message))
  }, [])

  return (
    <Centered>
      <h1>Writey</h1>
      <p>Signed in as {session.user.email}</p>
      <p className="muted">
        {me
          ? `Server verified you (${me.userId.slice(0, 8)}…)`
          : error
            ? `Server check failed: ${error}`
            : 'Checking with server…'}
      </p>
      <button type="button" onClick={() => supabase.auth.signOut()}>
        Sign out
      </button>
    </Centered>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="centered">{children}</main>
}
