// Talks to Writey Helper on this computer (apps/helper, docs §7.3). ChatGPT tokens live in
// the Helper; the browser only keeps the pairing token that proves it's allowed to ask.

export const HELPER_URL = 'http://127.0.0.1:47823'
const TOKEN_KEY = 'writey.helper.token'

export type HelperState = { running: boolean; paired: boolean }

export type ChatgptStatus = {
  signed_in: boolean
  email: string | null
  /** The plan-usage scope was granted, so requests can use the ChatGPT plan. */
  plan_usage: boolean
  /** First sign-in: show the "You're using your ChatGPT plan" notice once. */
  welcome: boolean
  login_pending: boolean
  error: string | null
}

export class HelperError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: string,
  ) {
    super(code)
  }
}

function pairingToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

/** True once this browser has paired; until then Writey never contacts the Helper by itself. */
export const hasPairing = () => Boolean(pairingToken())

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = pairingToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body) headers.set('Content-Type', 'application/json')
  try {
    return await fetch(`${HELPER_URL}${path}`, { ...init, headers })
  } catch (e) {
    if (init.signal?.aborted && (e as Error).name === 'AbortError') throw e
    throw new HelperError(0, 'helper_offline', '')
  }
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await call(path, init)
  if (!res.ok) {
    const body = await res.text()
    let code = `http_${res.status}`
    try {
      const parsed = JSON.parse(body) as { error?: unknown }
      if (typeof parsed.error === 'string') code = parsed.error
    } catch {}
    throw new HelperError(res.status, code, body)
  }
  return (await res.json()) as T
}

export async function helperHealth(): Promise<HelperState> {
  try {
    const h = await json<{ paired: boolean }>('/health', { signal: AbortSignal.timeout(2000) })
    return { running: true, paired: h.paired }
  } catch {
    return { running: false, paired: false }
  }
}

export async function pairHelper(code: string): Promise<void> {
  const { token } = await json<{ token: string }>('/pair', {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
  localStorage.setItem(TOKEN_KEY, token)
}

export const chatgptStatus = () => json<ChatgptStatus>('/chatgpt/status')

export const chatgptLogin = () => json<{ started: boolean }>('/chatgpt/login', { method: 'POST' })

export const chatgptWelcomed = () => json<{ ok: boolean }>('/chatgpt/welcomed', { method: 'POST' })

export const chatgptLogout = (forget = false) =>
  json<{ revoked: boolean | null }>('/chatgpt/logout', {
    method: 'POST',
    body: JSON.stringify({ forget }),
  })

export const chatgptModels = () => json<unknown>('/chatgpt/models')

/** Streams a Responses API call through the Helper. The caller reads the response. */
export const chatgptResponses = (body: string, signal: AbortSignal) =>
  call('/chatgpt/responses', { method: 'POST', body, signal })
