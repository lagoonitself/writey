// Signs the desktop app in to the Writey account (apps/desktop/src/sync/auth.rs). Supabase only
// sends Google sign-ins back to this website, so the app opens
// `/?desktop_login=PORT&challenge=…&state=…`; this tab goes through Google with the app's PKCE
// challenge and, back here with a code, hands the code to the app on 127.0.0.1:PORT. Only the
// app holds the verifier, so only it can turn the code into a session.

const KEY = 'writey.desktopLogin'
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined

type Pending = { port: number; state: string }

function read(): Pending | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Pending) : null
  } catch {
    return null
  }
}

export function desktopLoginPending(): boolean {
  if (typeof location === 'undefined') return false
  return new URLSearchParams(location.search).has('desktop_login') || read() !== null
}

/** Runs before the app renders; true if this tab is busy with a desktop sign-in. */
export function runDesktopLogin(): boolean {
  if (typeof location === 'undefined' || !SUPABASE_URL) return false
  const params = new URLSearchParams(location.search)
  const port = Number(params.get('desktop_login'))
  const challenge = params.get('challenge')
  const state = params.get('state')
  if (port > 0 && port < 65536 && challenge && state) {
    sessionStorage.setItem(KEY, JSON.stringify({ port, state }))
    const auth = new URL('/auth/v1/authorize', SUPABASE_URL)
    auth.searchParams.set('provider', 'google')
    auth.searchParams.set('redirect_to', location.origin)
    auth.searchParams.set('code_challenge', challenge)
    auth.searchParams.set('code_challenge_method', 's256')
    location.replace(auth)
    return true
  }
  const pending = read()
  if (!pending) return false
  sessionStorage.removeItem(KEY)
  const back = new URL(`http://127.0.0.1:${pending.port}/account`)
  back.searchParams.set('state', pending.state)
  const code = params.get('code')
  if (code) back.searchParams.set('code', code)
  else
    back.searchParams.set(
      'error',
      params.get('error_description') ?? params.get('error') ?? 'cancelled',
    )
  location.replace(back)
  return true
}
