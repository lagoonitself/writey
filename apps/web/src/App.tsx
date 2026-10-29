import type { Session } from '@supabase/supabase-js'
import { useEffect, useRef, useState } from 'react'
import { finishOpenRouterConnect, OPENROUTER_CALLBACK } from './lib/ai'
import { isDesktop } from './lib/native'
import { navigate, usePath } from './lib/router'
import { supabase, supabaseConfigured } from './lib/web/supabase'
import { Library, Wordmark } from './notebook/Library'
import { NotebookView } from './notebook/NotebookView'
import { OPEN_SETTINGS_FLAG } from './settings/useAiState'
import { Site } from './site/Site'

/**
 * One UI, two homes (HANDOFF D57): the desktop app keeps notebooks on the computer and syncs
 * them with the Writey account; the website works on the account directly after Google sign-in.
 */
export function App() {
  return isDesktop() ? <Notebooks /> : <Website />
}

function Notebooks({ session }: { session?: Session }) {
  const path = usePath()
  if (!isDesktop() && path === OPENROUTER_CALLBACK) return <ConnectOpenRouter />
  const notebookId = /^\/n\/([0-9a-f-]{36})$/i.exec(path)?.[1]
  return notebookId ? (
    <NotebookView key={notebookId} id={notebookId} />
  ) : (
    <Library session={session} />
  )
}

function Website() {
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
        <Wordmark />
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
  return session ? <Notebooks session={session} /> : <Site />
}

/** Where OpenRouter sends the website back after "Connect OpenRouter". */
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
