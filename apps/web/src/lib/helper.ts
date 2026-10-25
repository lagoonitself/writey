// Talks to Writey Helper on this computer (apps/helper, docs §7.3). ChatGPT tokens live in
// the Helper; the browser only ever learns the email and whether plan usage is allowed.

export const HELPER_URL = 'http://127.0.0.1:47823'
const USED_KEY = 'writey.chatgpt.used'

/** Windows setup: installs uv if needed, then the Helper, which starts with Windows after. */
export const HELPER_SETUP_FILE = '/writey-helper-setup.cmd'

/** For macOS and Linux, where the Helper runs in a terminal for now. */
export const HELPER_COMMAND =
  'uvx --from "git+https://github.com/lagoonitself/writey#subdirectory=apps/helper" writey-helper'

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

/**
 * True once this browser has started a ChatGPT sign-in. Until then Writey never contacts
 * 127.0.0.1 by itself, because that makes Chrome ask about local network access.
 */
export function chatgptUsed(): boolean {
  try {
    return localStorage.getItem(USED_KEY) === '1'
  } catch {
    return false
  }
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
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

/** The Helper API level this Writey needs (2: sign-in by redirect, no pairing). */
const HELPER_API = 2

/** 'ok', 'outdated' (an older Helper that needs updating) or 'offline'. */
export type HelperState = 'ok' | 'outdated' | 'offline'

export async function helperState(): Promise<HelperState> {
  try {
    const h = await json<{ api?: number }>('/health', { signal: AbortSignal.timeout(2000) })
    return (h.api ?? 1) >= HELPER_API ? 'ok' : 'outdated'
  } catch {
    return 'offline'
  }
}

/**
 * Sends this tab to OpenAI's sign-in through the Helper; OpenAI returns to the Helper,
 * which sends you back here with `?chatgpt=connected` (or `=error`).
 */
export function connectChatgpt(switchAccount = false): void {
  try {
    localStorage.setItem(USED_KEY, '1')
  } catch {}
  const url = new URL('/chatgpt/connect', HELPER_URL)
  url.searchParams.set('return_to', location.origin + location.pathname)
  if (switchAccount) url.searchParams.set('switch', 'true')
  location.assign(url)
}

export const chatgptStatus = () => json<ChatgptStatus>('/chatgpt/status')

export const chatgptWelcomed = () => json<{ ok: boolean }>('/chatgpt/welcomed', { method: 'POST' })

export const chatgptLogout = () =>
  json<{ revoked: boolean | null }>('/chatgpt/logout', { method: 'POST', body: '{}' })

export const chatgptModels = () => json<unknown>('/chatgpt/models')

/** Streams a Responses API call through the Helper. The caller reads the response. */
export const chatgptResponses = (body: string, signal: AbortSignal) =>
  call('/chatgpt/responses', { method: 'POST', body, signal })
