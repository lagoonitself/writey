import { CHATGPT_USAGE_URL } from '@writey/ai-core'
import { useEffect, useRef, useState } from 'react'
import { saveAiSettings } from '../lib/ai'
import { chatgptLogin, chatgptLogout, HELPER_URL, HelperError, pairHelper } from '../lib/helper'
import { type AiState, probeHelper, usable } from './useAiState'

/** Runs the Helper straight from GitHub with uv; no clone or install step. */
const HELPER_COMMAND =
  'uvx --from "git+https://github.com/lagoonitself/writey#subdirectory=apps/helper" writey-helper'

const SIGN_IN_TIMEOUT_MS = 600_000

function helperMessage(e: unknown): string {
  const code = e instanceof HelperError ? e.code : ''
  if (code === 'helper_offline') {
    return 'Writey can’t reach the Helper. Is it running? If Chrome asks about devices on your local network, allow it.'
  }
  if (code === 'bad_code') return 'That code doesn’t match. Check the Helper window.'
  if (code === 'locked') return 'Too many wrong codes. Restart the Helper to get a new one.'
  if (code === 'not_paired') return 'The Helper doesn’t know this browser yet. Pair again.'
  return (e as Error).message
}

/**
 * Sign in with ChatGPT, which lives in Writey Helper (HANDOFF D15): start the Helper,
 * pair this browser once, then "Continue with ChatGPT" opens OpenAI's sign-in.
 */
export function ChatgptCard({ ai, onChange }: { ai: AiState; onChange(next: AiState): void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [checked, setChecked] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(ai)
  latest.current = ai
  const { helper, chatgpt: status } = ai
  const signedIn = Boolean(status?.signed_in)

  const refresh = async () => {
    const h = await probeHelper()
    let next: AiState = { ...latest.current, ...h }
    // Signed in with plan usage and nothing else set up: switch to ChatGPT right away.
    // The model picker then takes the plan's first model.
    if (h.chatgpt?.plan_usage && !usable(latest.current, latest.current.settings.provider)) {
      next = { ...next, settings: { provider: 'chatgpt', model: '' } }
      await saveAiSettings(next.settings).catch(() => {})
    }
    onChange(next)
    return h
  }

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(helperMessage(e))
    } finally {
      setBusy(false)
    }
  }

  // While you finish signing in in the tab the Helper opened, keep asking how it went.
  // biome-ignore lint/correctness/useExhaustiveDependencies: polls only while waiting
  useEffect(() => {
    if (!waiting) return
    let stop = false
    let timer = 0
    const started = Date.now()
    const tick = async () => {
      const h = await refresh().catch(() => null)
      if (stop) return
      const s = h?.chatgpt
      if (!s || s.signed_in || !s.login_pending || Date.now() - started > SIGN_IN_TIMEOUT_MS) {
        setWaiting(false)
        if (s?.error) setError(s.error)
        return
      }
      timer = window.setTimeout(tick, 1500)
    }
    timer = window.setTimeout(tick, 1500)
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [waiting])

  const login = (forgetFirst = false) =>
    act(async () => {
      if (forgetFirst) await chatgptLogout(true)
      await chatgptLogin()
      setWaiting(true)
    })

  const logout = () =>
    act(async () => {
      const { revoked } = await chatgptLogout(false)
      await refresh()
      if (revoked === false) {
        setError(
          'Signed out here, but ChatGPT didn’t confirm it. You can also disconnect Writey in ChatGPT settings.',
        )
      }
    })

  let body: React.ReactNode
  if (!helper?.running) {
    body = (
      <>
        <p className="small">
          Start the Helper in a terminal. It needs{' '}
          <a
            href="https://docs.astral.sh/uv/getting-started/installation/"
            target="_blank"
            rel="noopener noreferrer"
          >
            uv
          </a>
          .
        </p>
        <div className="command-row">
          <code className="command">{HELPER_COMMAND}</code>
          <button
            type="button"
            className="small-btn"
            onClick={() => {
              void navigator.clipboard.writeText(HELPER_COMMAND)
              setCopied(true)
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <button
          type="button"
          onClick={() =>
            act(async () => {
              const h = await refresh()
              setChecked(true)
              if (!h.helper?.running) throw new HelperError(0, 'helper_offline', '')
            })
          }
          disabled={busy}
        >
          {checked ? 'Check again' : 'It’s running'}
        </button>
      </>
    )
  } else if (!helper.paired) {
    body = (
      <>
        <form
          className="provider-row"
          onSubmit={(e) => {
            e.preventDefault()
            void act(async () => {
              await pairHelper(code)
              setCode('')
              await refresh()
            })
          }}
        >
          <input
            className="key-input"
            placeholder="Pairing code from the Helper"
            inputMode="numeric"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-label="Helper pairing code"
          />
          <button type="submit" disabled={busy || code.replace(/\D/g, '').length !== 6}>
            Pair
          </button>
        </form>
        <p className="muted small">
          The six-digit code is in the Helper window, or at{' '}
          <a href={HELPER_URL} target="_blank" rel="noopener noreferrer">
            127.0.0.1:47823
          </a>
          .
        </p>
      </>
    )
  } else if (!signedIn) {
    body = (
      <>
        <button
          type="button"
          className="primary connect"
          onClick={() => login()}
          disabled={busy || waiting}
        >
          Continue with ChatGPT
        </button>
        {waiting && (
          <p className="muted small">Finish signing in in the browser tab that just opened…</p>
        )}
      </>
    )
  } else {
    body = (
      <>
        <div className="provider-row">
          <span className="small">{status?.email ?? 'Signed in'}</span>
          <button type="button" className="ghost small-btn" onClick={logout} disabled={busy}>
            Sign out
          </button>
        </div>
        {status?.plan_usage ? (
          <p className="small">
            Using your ChatGPT plan ·{' '}
            <a href={CHATGPT_USAGE_URL} target="_blank" rel="noopener noreferrer">
              Manage usage
            </a>
          </p>
        ) : (
          <>
            <p className="error small">
              ChatGPT plan usage isn’t enabled. Sign in again and allow it, or use an OpenRouter or
              OpenCode Zen key.
            </p>
            <button type="button" onClick={() => login()} disabled={busy || waiting}>
              Continue with ChatGPT
            </button>
          </>
        )}
        <button
          type="button"
          className="link-btn small"
          onClick={() => login(true)}
          disabled={busy || waiting}
        >
          Use another account
        </button>
        {waiting && (
          <p className="muted small">Finish signing in in the browser tab that just opened…</p>
        )}
      </>
    )
  }

  return (
    <div className={`provider-card${signedIn ? ' connected' : ''}`}>
      <div className="provider-head">
        <span className="provider-name">ChatGPT</span>
        {signedIn && <span className="provider-badge">Connected</span>}
      </div>
      <p className="muted small">
        Use your ChatGPT Plus or Pro plan in Writey. Sign-in runs in the free Writey Helper app on
        this computer, so your ChatGPT tokens never leave it.
      </p>
      {body}
      {error && <p className="error small">{error}</p>}
    </div>
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
