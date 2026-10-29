import { CHATGPT_USAGE_URL } from '@writey/ai-core'
import { useEffect, useRef, useState } from 'react'
import { saveAiSettings } from '../lib/ai'
import { chatgptCancelLogin, chatgptLogin, chatgptLogout, chatgptStatus } from '../lib/chatgpt'
import { ChatgptIcon } from '../notebook/icons'
import { ProviderMark } from './ProviderMark'
import type { AiState } from './useAiState'

/**
 * Sign in with ChatGPT (HANDOFF D15, D57). "Continue with ChatGPT" opens OpenAI's sign-in in
 * your browser; it comes back to Writey on this computer, which keeps the login. Nothing
 * else to install.
 */
export function ChatgptPanel({ ai, onChange }: { ai: AiState; onChange(next: AiState): void }) {
  const [waiting, setWaiting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(ai)
  latest.current = ai
  const status = ai.chatgpt
  const signedIn = Boolean(status?.signed_in)

  useEffect(() => () => void (waiting && chatgptCancelLogin().catch(() => {})), [waiting])

  const go = async (switchAccount = false) => {
    setError(null)
    setWaiting(true)
    try {
      const next = await chatgptLogin(switchAccount)
      let settings = latest.current.settings
      // Just signed in and nothing else is set up: use ChatGPT right away (the model
      // picker then takes the plan's first model).
      if (
        next.plan_usage &&
        settings.provider !== 'chatgpt' &&
        !latest.current.credentials.length
      ) {
        settings = { provider: 'chatgpt', model: '' }
        await saveAiSettings(settings).catch(() => {})
      }
      onChange({ ...latest.current, chatgpt: next, settings })
      if (next.error) setError(next.error)
    } catch (e) {
      setError((e as Error).message)
      onChange({ ...latest.current, chatgpt: await chatgptStatus().catch(() => null) })
    } finally {
      setWaiting(false)
    }
  }

  const cancel = () => {
    void chatgptCancelLogin()
    setWaiting(false)
  }

  const signOut = async () => {
    setBusy(true)
    setError(null)
    try {
      const { revoked } = await chatgptLogout()
      onChange({ ...latest.current, chatgpt: await chatgptStatus() })
      if (revoked === false) {
        setError(
          'Signed out here, but ChatGPT didn’t confirm it. You can also remove Writey in your ChatGPT settings.',
        )
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const errorLine = (error || status?.error) && (
    <p className="inline-error" role="alert">
      {error ?? status?.error}
    </p>
  )

  if (waiting) {
    return (
      <div className="setup">
        <span className="waiting">
          <span className="spinner" aria-hidden="true" />
          Finish signing in in your browser: pick your account and allow “Use your ChatGPT plan”.
        </span>
        <div className="actions">
          <button type="button" className="link-btn" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  if (signedIn) {
    return (
      <>
        <div className="account-line">
          <span>
            Signed in as <strong>{status?.email ?? 'your ChatGPT account'}</strong>
          </span>
        </div>
        {status?.plan_usage ? (
          <p>
            Using your ChatGPT plan ·{' '}
            <a href={CHATGPT_USAGE_URL} target="_blank" rel="noopener noreferrer">
              Manage usage
            </a>
          </p>
        ) : (
          <>
            <p className="inline-error">
              ChatGPT plan usage isn’t on for Writey. Sign in again and allow “Use your ChatGPT
              plan”.
            </p>
            <ContinueButton onClick={() => go()} />
          </>
        )}
        <div className="actions">
          <button type="button" className="link-btn" onClick={() => go(true)}>
            Use another account
          </button>
          <button type="button" className="link-btn" onClick={signOut} disabled={busy}>
            Sign out
          </button>
        </div>
        {status?.plan_usage && errorLine}
      </>
    )
  }

  return (
    <>
      <p>
        <strong>Use your ChatGPT plan.</strong> Complete eligible AI requests in Writey with usage
        included in your ChatGPT plan or credits balance. No API key.
      </p>
      <ContinueButton onClick={() => go()} />
      {errorLine}
    </>
  )
}

function ContinueButton({ onClick }: { onClick(): void }) {
  return (
    <button type="button" className="chatgpt-btn" onClick={onClick}>
      <ChatgptIcon size={18} />
      Continue with ChatGPT
    </button>
  )
}

/** Shown once, after the first ChatGPT sign-in, worded as OpenAI's UI guidelines require. */
export function WelcomeNotice({ onDone }: { onDone(): void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])
  return (
    <dialog ref={ref} className="welcome" onClose={onDone} aria-labelledby="welcome-title">
      <ProviderMark provider="chatgpt" />
      <h2 id="welcome-title">You’re using your ChatGPT plan</h2>
      <p>
        Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.
      </p>
      <button type="button" className="primary" onClick={() => ref.current?.close()}>
        Got it
      </button>
    </dialog>
  )
}
