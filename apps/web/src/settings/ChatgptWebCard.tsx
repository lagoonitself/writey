import { CHATGPT_USAGE_URL } from '@writey/ai-core'
import { useEffect, useRef, useState } from 'react'
import {
  chatgptLogout,
  connectChatgpt,
  HELPER_COMMAND,
  HELPER_SETUP_FILE,
  helperState,
} from '../lib/web/helper'
import { ChatgptIcon, DownloadIcon } from '../notebook/icons'
import { type AiState, chatgptReturn, probeHelper } from './useAiState'

const POLL_MS = 2000
const isWindows = /Windows/i.test(navigator.userAgent)
const UV_COMMAND = 'curl -LsSf https://astral.sh/uv/install.sh | sh'

let returnErrorShown = false

/** The sign-in error the Helper sent back with, shown once. */
function takeReturnError(): string | null {
  const error = returnErrorShown ? null : (chatgptReturn?.error ?? null)
  setTimeout(() => {
    returnErrorShown = true
  }, 0)
  return error
}

/**
 * Sign in with ChatGPT (HANDOFF D15, D25). "Continue with ChatGPT" sends this tab through
 * Writey Helper to OpenAI and back. OpenAI only allows that sign-in from apps on your own
 * computer (a 127.0.0.1 callback), so the first time, the Helper gets installed.
 */
export function ChatgptWebPanel({
  ai,
  onChange,
  onInstead,
}: {
  ai: AiState
  onChange(next: AiState): void
  /** Opens a provider that needs nothing installed. */
  onInstead?(): void
}) {
  const ready = ai.helper === 'ok'
  const outdated = ai.helper === 'outdated'
  const [setup, setSetup] = useState(ai.helper === 'offline' || outdated)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(takeReturnError)
  const latest = useRef(ai)
  latest.current = ai
  const status = ai.chatgpt
  const signedIn = Boolean(status?.signed_in)

  const go = async (switchAccount = false) => {
    setError(null)
    setChecking(true)
    const state = await helperState()
    setChecking(false)
    if (state === 'ok') connectChatgpt(switchAccount)
    else {
      onChange({ ...latest.current, helper: state })
      setSetup(true)
    }
  }

  // While setup is open, notice when the Helper starts.
  useEffect(() => {
    if (!setup || ready) return
    let stop = false
    let timer = 0
    const tick = async () => {
      if ((await helperState()) === 'ok') {
        if (stop) return
        const h = await probeHelper()
        onChange({ ...latest.current, ...h })
        return
      }
      if (!stop) timer = window.setTimeout(tick, POLL_MS)
    }
    timer = window.setTimeout(tick, POLL_MS)
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [setup, ready, onChange])

  const signOut = async () => {
    setBusy(true)
    setError(null)
    try {
      const { revoked } = await chatgptLogout()
      onChange({ ...latest.current, ...(await probeHelper()) })
      if (revoked === false) {
        setError(
          'Signed out here, but ChatGPT didn’t confirm it. You can also remove Writey in your ChatGPT settings.',
        )
      }
    } catch {
      setError('Writey Helper isn’t running, so it couldn’t sign out.')
    } finally {
      setBusy(false)
    }
  }

  const errorLine = (error || status?.error) && (
    <p className="inline-error" role="alert">
      {error ?? status?.error}
    </p>
  )

  if (signedIn && ready) {
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
            <ContinueButton onClick={() => go()} busy={checking} />
          </>
        )}
        <div className="actions">
          <button type="button" className="link-btn" onClick={() => go(true)} disabled={checking}>
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

  const found = ready ? 'done' : ''
  return (
    <>
      <p>
        <strong>Use your ChatGPT plan.</strong> Complete eligible AI requests in Writey with usage
        included in your ChatGPT plan or credits balance. No API key.
      </p>
      {!setup && <ContinueButton onClick={() => go()} busy={checking} />}
      {setup && (
        <div className="setup">
          <span className="setup-title">
            {ready
              ? 'Writey Helper is running. Last step:'
              : outdated
                ? 'Update Writey Helper'
                : 'One-time setup: Writey Helper'}
          </span>
          {!ready && (
            <p className="setup-why">
              {outdated
                ? 'The Writey Helper on this computer is an older version. Run the setup again to update it; your sign-in is kept.'
                : 'OpenAI lets ChatGPT sign in only to apps on your own computer, not to websites. Writey Helper is that app: small, free and open source. It only handles the sign-in and keeps your ChatGPT login on this computer.'}
            </p>
          )}
          <ol>
            {isWindows ? (
              <>
                <li className={found}>
                  <span>
                    Download the setup file.
                    {!ready && (
                      <a
                        className="btn primary"
                        href={HELPER_SETUP_FILE}
                        download="writey-helper-setup.cmd"
                      >
                        <DownloadIcon size={16} />
                        Download Writey Helper
                      </a>
                    )}
                    {!ready && (
                      <small className="setup-note">
                        If Chrome says it isn’t commonly downloaded, choose <em>Keep</em>.
                      </small>
                    )}
                  </span>
                </li>
                <li className={found}>
                  <span>
                    Open the downloaded file. If Windows says it protected your PC, click{' '}
                    <em>More info → Run anyway</em>. It installs in under a minute, then starts by
                    itself whenever you sign in to Windows.
                  </span>
                </li>
              </>
            ) : (
              <>
                <li className={found}>
                  <span>
                    Open Terminal and install uv, the Python tool manager (once):
                    {!ready && <CommandRow command={UV_COMMAND} />}
                  </span>
                </li>
                <li className={found}>
                  <span>
                    Start Writey Helper and leave that window open while you use Writey:
                    {!ready && <CommandRow command={HELPER_COMMAND} />}
                  </span>
                </li>
              </>
            )}
            <li className={found}>
              <span>
                Come back to this tab. If Chrome asks to let Writey look for devices on your local
                network, choose <em>Allow</em>: that’s how Writey finds the Helper.
                {!ready && (
                  <span className="waiting">
                    <span className="spinner" aria-hidden="true" />
                    Looking for Writey Helper…
                  </span>
                )}
              </span>
            </li>
            <li>
              <span>
                Continue with ChatGPT, pick your account and allow “Use your ChatGPT plan”. You come
                back here signed in.
                {ready && <ContinueButton onClick={() => go()} busy={checking} />}
              </span>
            </li>
          </ol>
          {!ready && isWindows && (
            <details className="other-os">
              <summary>Prefer a terminal?</summary>
              <CommandRow command={HELPER_COMMAND} />
            </details>
          )}
          {!ready && onInstead && (
            <p className="setup-instead">
              Rather not install anything?{' '}
              <button type="button" className="link-btn" onClick={onInstead}>
                Use an OpenRouter key instead
              </button>
              : it works right away in the browser.
            </p>
          )}
        </div>
      )}
      {errorLine}
    </>
  )
}

function ContinueButton({ onClick, busy }: { onClick(): void; busy: boolean }) {
  return (
    <button type="button" className="chatgpt-btn" onClick={onClick} disabled={busy}>
      {busy ? <span className="spinner" aria-hidden="true" /> : <ChatgptIcon size={18} />}
      Continue with ChatGPT
    </button>
  )
}

function CommandRow({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="command-row">
      <code className="command">{command}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(command)
          setCopied(true)
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
