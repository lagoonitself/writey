import { useState } from 'react'
import { supabase } from '../lib/web/supabase'
import { GoogleIcon } from '../notebook/icons'
import { Wordmark } from '../notebook/Library'
import { Scribble } from '../Scribble'

const RELEASES = 'https://github.com/lagoonitself/writey/releases/latest'
const WINDOWS = `${RELEASES}/download/Writey-Windows-Setup.exe`
const MAC = `${RELEASES}/download/Writey-macOS-AppleSilicon.dmg`

/**
 * The website's sign-in page (HANDOFF D57): use Writey right here with Google, or download the
 * desktop app; both show the same notebooks once signed in to the same account.
 */
export function Site() {
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
        <button type="button" className="google" onClick={signIn}>
          <GoogleIcon />
          Continue with Google
        </button>
        {error && <p className="error">{error}</p>}
        <p className="signin-fine">Or get the app, with voice on your GPU and offline notebooks:</p>
        <div className="download-row">
          <a className="btn" href={WINDOWS}>
            Download for Windows
          </a>
          <a className="btn" href={MAC}>
            Download for Mac (Apple Silicon)
          </a>
        </div>
        <p className="signin-fine">
          Free and open source. Writey uses <strong>your own AI</strong>: your ChatGPT plan,
          OpenRouter or OpenCode Zen. Sign in with the same Google account on the website and in the
          app and your notebooks stay in sync. <a href={RELEASES}>All downloads and notes</a>
        </p>
        <FirstOpen />
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
