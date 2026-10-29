import type { Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { GoogleIcon } from '../notebook/icons'
import { Wordmark } from '../notebook/Library'
import { Scribble } from '../Scribble'
import { exportEverything } from './exporter'
import { supabase, supabaseConfigured } from './supabase'

const RELEASES = 'https://github.com/lagoonitself/writey/releases/latest'
const WINDOWS = `${RELEASES}/download/Writey-Windows-Setup.exe`
const MAC = `${RELEASES}/download/Writey-macOS-AppleSilicon.dmg`

const isMacVisitor = /Mac/i.test(navigator.platform)

/**
 * The website (HANDOFF D57): Writey is a desktop app now. This page offers the download and,
 * for anyone who used the web version, a one-time export of their notebooks.
 */
export function Site() {
  return (
    <main className="signin">
      <Scribble />
      <section className="signin-copy">
        <Wordmark />
        <h1>
          Your notebook <em>that writes back.</em>
        </h1>
        <p className="signin-lede">
          Work through problems with your pen. When you’re stuck, say “Hey, what’s next?” It reads
          the page and writes the next step under your own, or sketches and explains it like a tutor
          with a pen. Voice runs on your own GPU.
        </p>
        <div className="download-row">
          <a className={`btn${isMacVisitor ? '' : ' primary'}`} href={WINDOWS}>
            Download for Windows
          </a>
          <a className={`btn${isMacVisitor ? ' primary' : ''}`} href={MAC}>
            Download for Mac (Apple Silicon)
          </a>
        </div>
        <p className="signin-fine">
          Free and open source. Writey uses <strong>your own AI</strong>: your ChatGPT plan,
          OpenRouter or OpenCode Zen. Notebooks stay on your computer.{' '}
          <a href={RELEASES}>All downloads and notes</a>
        </p>
        <FirstOpen />
        {supabaseConfigured && <ExportOld />}
      </section>
      <DemoSheet />
    </main>
  )
}

function FirstOpen() {
  return (
    <details className="first-open">
      <summary>First time opening it?</summary>
      <p>
        <strong>Windows:</strong> if SmartScreen says it protected your PC, choose{' '}
        <em>More info → Run anyway</em>.
      </p>
      <p>
        <strong>Mac:</strong> open the .dmg and drag Writey to Applications. The first time, right
        click Writey and choose <em>Open</em> (or allow it in System Settings → Privacy &amp;
        Security).
      </p>
    </details>
  )
}

/** For people who used the web version: everything they had, as one .writey file. */
function ExportOld() {
  const [session, setSession] = useState<Session | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  const signIn = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      // Must match the Supabase redirect allow list, which holds origins only.
      options: { redirectTo: window.location.origin },
    })
    if (error) setStatus(error.message)
  }

  const download = async () => {
    setBusy(true)
    try {
      const blob = await exportEverything(setStatus)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `Writey notebooks ${new Date().toISOString().slice(0, 10)}.writey`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000)
      setStatus('Downloaded. In the Writey app: Settings → Notebooks → Import a .writey file.')
    } catch (e) {
      setStatus((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="export-old" id="export">
      <h2>Used Writey on the web?</h2>
      {session ? (
        <>
          <p>
            Signed in as <strong>{session.user.email}</strong>. Download every notebook, page, PDF
            and conversation as one file, then import it in the app.
          </p>
          <div className="download-row">
            <button type="button" className="primary" onClick={download} disabled={busy}>
              {busy ? 'Exporting…' : 'Export my notebooks'}
            </button>
            <button type="button" className="link-btn" onClick={() => supabase.auth.signOut()}>
              Sign out
            </button>
          </div>
        </>
      ) : (
        <>
          <p>Sign in once more to take your notebooks with you.</p>
          <button type="button" className="google" onClick={signIn}>
            <GoogleIcon />
            Continue with Google
          </button>
        </>
      )}
      {status && <p className="note">{status}</p>}
    </section>
  )
}

/** A page of working with Writey's next lines writing themselves in, in blue ink. */
function DemoSheet() {
  return (
    <figure className="signin-sheet" aria-hidden="true">
      <span className="sheet-ask">Hey, what’s next?</span>
      <span className="sheet-line q">3. Find ∫ x eˣ dx</span>
      <span className="sheet-line">by parts:</span>
      <span className="sheet-line">u = x, dv = eˣ dx</span>
      <span className="sheet-line">du = dx, v = eˣ</span>
      <span className="sheet-line ai" style={{ '--d': '1600ms' } as React.CSSProperties}>
        = x eˣ − ∫ eˣ dx
      </span>
      <span className="sheet-line ai" style={{ '--d': '3000ms' } as React.CSSProperties}>
        = x eˣ − eˣ + C
      </span>
      <span className="sheet-line ai" style={{ '--d': '4400ms' } as React.CSSProperties}>
        = eˣ (x − 1) + C
      </span>
      <span className="sheet-ghost">
        <span>Accept</span>
        <span>Redo</span>
        <span>Why?</span>
      </span>
    </figure>
  )
}
