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

const VOICE_USED_KEY = 'writey.voice.used'

/** True once this browser has reached the Helper for voice or ChatGPT. */
export function helperKnown(): boolean {
  try {
    return chatgptUsed() || localStorage.getItem(VOICE_USED_KEY) === '1'
  } catch {
    return false
  }
}

export function markHelperKnown(): void {
  try {
    localStorage.setItem(VOICE_USED_KEY, '1')
  } catch {}
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
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

// ---------------------------------------------------------------------------
// Voice: local speech models in the Helper (docs §7). Helper 0.5 dropped these endpoints and
// voice is switched off (VOICE_ENABLED, HANDOFF D56); kept for when voice comes back.
// ---------------------------------------------------------------------------

/** The Helper API level voice needs (3: /stt, /tts, /voice/*; 4: models on the GPU). */
export const VOICE_API = 4

export type Device = 'cuda' | 'cpu'

export type ModelStatus = {
  model: string
  state: 'missing' | 'downloaded' | 'downloading' | 'loading' | 'ready' | 'error'
  device?: Device
  progress?: number
  error?: string
}

export type VoiceStatus = {
  device?: Device
  stt: ModelStatus
  tts: ModelStatus & { voices: string[] }
}

/** 'ok', 'outdated' (no voice yet) or 'offline'. */
export async function voiceHelperState(): Promise<HelperState> {
  try {
    const h = await json<{ api?: number }>('/health', { signal: AbortSignal.timeout(2000) })
    return (h.api ?? 1) >= VOICE_API ? 'ok' : 'outdated'
  } catch {
    return 'offline'
  }
}

export const voiceStatus = () => json<VoiceStatus>('/voice/status')

/** Downloads (the first time) and loads the speech models in the background. */
export const voicePrepare = (which: { stt?: boolean; tts?: boolean } = {}) =>
  json<VoiceStatus>('/voice/prepare', { method: 'POST', body: JSON.stringify(which) })

/** A failed voice call, with the Helper's error code (e.g. `not_ready`). */
async function failure(res: Response): Promise<HelperError> {
  let code = `http_${res.status}`
  const body = await res.text()
  try {
    code = (JSON.parse(body) as { error?: string }).error ?? code
  } catch {}
  return new HelperError(res.status, code, body)
}

/** One speech segment (16 kHz mono floats) to text. */
export async function transcribe(audio: Float32Array, signal?: AbortSignal): Promise<string> {
  const pcm = new Int16Array(audio.length)
  for (let i = 0; i < audio.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round((audio[i] as number) * 32767)))
  }
  const res = await call('/stt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: pcm.buffer,
    signal,
  })
  if (!res.ok) throw await failure(res)
  return ((await res.json()) as { text: string }).text
}

/** Text to WAV audio. */
export async function synthesize(
  text: string,
  voice: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const res = await call('/tts', { method: 'POST', body: JSON.stringify({ text, voice }), signal })
  if (!res.ok) throw await failure(res)
  return res.arrayBuffer()
}
