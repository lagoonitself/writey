import type { Session } from '@supabase/supabase-js'
import { useEffect, useRef, useState } from 'react'
import { finishOpenRouterConnect, OPENROUTER_CALLBACK } from './lib/ai'
import { navigate, usePath } from './lib/router'
import { supabase, supabaseConfigured } from './lib/supabase'
import { GoogleIcon } from './notebook/icons'
import { Library, Wordmark } from './notebook/Library'
import { NotebookView } from './notebook/NotebookView'
import { Scribble } from './Scribble'
import { OPEN_SETTINGS_FLAG } from './settings/useAiState'

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
        <Wordmark big />
        <p className="muted">
          Supabase isn't configured. Copy <code>apps/web/.env.example</code> to{' '}
          <code>.env.local</code> and fill it in.
        </p>
      </Centered>
    )
  }
  if (loading)
    return (
      <Centered>
        <span className="loader" role="status" aria-label="Loading" />
      </Centered>
    )
  return session ? <Signed session={session} /> : <SignIn />
}

function Signed({ session }: { session: Session }) {
  const path = usePath()
  if (path === OPENROUTER_CALLBACK) return <ConnectOpenRouter />
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
    <main className="signin">
      <Scribble />
      <div className="signin-card">
        <h1>
          <Wordmark big />
        </h1>
        <p className="tagline">Your notebook that writes back.</p>
        <button type="button" className="google" onClick={signIn}>
          <GoogleIcon />
          Continue with Google
        </button>
        {error && <p className="error">{error}</p>}
      </div>
      <p className="scribble-hint">Go on, scribble anywhere.</p>
    </main>
  )
}

/** Where OpenRouter sends you back after "Connect OpenRouter". */
function ConnectOpenRouter() {
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    const code = new URLSearchParams(location.search).get('code')
    if (!code) {
      setError('OpenRouter didn’t send a sign-in code. Try connecting again.')
      return
    }
    finishOpenRouterConnect(code)
      .then((back) => {
        sessionStorage.setItem(OPEN_SETTINGS_FLAG, '1')
        history.replaceState(null, '', '/')
        navigate(back)
      })
      .catch((e: Error) => setError(e.message))
  }, [])
  return (
    <Centered>
      {error ? (
        <>
          <p className="error">{error}</p>
          <button type="button" onClick={() => navigate('/')}>
            Back to notebooks
          </button>
        </>
      ) : (
        <>
          <span className="loader" role="status" aria-label="Connecting" />
          <p className="muted">Connecting OpenRouter…</p>
        </>
      )}
    </Centered>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="centered">{children}</main>
}
