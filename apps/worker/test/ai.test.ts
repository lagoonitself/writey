import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decryptSecret, encryptSecret, fromPgBytea, toPgBytea } from '../src/crypto'

vi.mock('../src/auth', () => ({
  supabaseJwks: () => null,
  verifySupabaseToken: async (token: string) =>
    token === 'good' ? { userId: 'user-1', email: 'a@b.c' } : null,
}))

const { default: app } = await import('../src/index')

const MASTER = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)))

type Call = { method: string; url: URL; headers: Headers; body: string | null }
let calls: Call[]
let handler: (call: Call) => Response | Promise<Response>

const env = () => ({
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'pk',
  CREDENTIALS_KEY: MASTER,
  FILES: {},
})
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} }
const json = (data: unknown, status = 200) => Response.json(data, { status })

function call(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', 'Bearer good')
  return app.request(path, { ...init, headers }, env(), ctx as unknown as ExecutionContext)
}

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const body = init.body
    const c = {
      method: init.method ?? 'GET',
      url: new URL(input),
      headers: new Headers(init.headers),
      body:
        body == null
          ? null
          : typeof body === 'string'
            ? body
            : new TextDecoder().decode(body as ArrayBuffer),
    }
    calls.push(c)
    return handler(c)
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('crypto', () => {
  it('round-trips and binds the ciphertext to user and provider', async () => {
    const { ciphertext, iv } = await encryptSecret(MASTER, 'u1', 'openrouter', 'sk-or-secret')
    const back = fromPgBytea(toPgBytea(ciphertext))
    expect(await decryptSecret(MASTER, 'u1', 'openrouter', back, iv)).toBe('sk-or-secret')
    expect(await decryptSecret(MASTER, 'u2', 'openrouter', back, iv)).toBeNull()
    expect(await decryptSecret(MASTER, 'u1', 'opencode-zen', back, iv)).toBeNull()
  })
})

describe('credentials', () => {
  const save = (provider: string, key: string) =>
    call(`/api/credentials/${provider}`, {
      method: 'PUT',
      body: JSON.stringify({ key }),
      headers: { 'Content-Type': 'application/json' },
    })

  it('encrypts the key and saves it through save_provider_secret, returning only last4', async () => {
    handler = (c) =>
      c.url.hostname === 'openrouter.ai' ? json({ data: {} }) : json('2026-10-25T00:00:00Z')
    const res = await save('openrouter', 'sk-or-v1-abcdefgh1234')
    expect(res.status).toBe(200)
    const info = (await res.json()) as { last4: string; created_at: string }
    expect(info).toMatchObject({ last4: '1234', created_at: '2026-10-25T00:00:00Z' })
    expect(JSON.stringify(info)).not.toContain('abcdefgh')

    const rpc = calls.find((c) => c.url.pathname === '/rest/v1/rpc/save_provider_secret')
    const args = JSON.parse(rpc?.body ?? '{}')
    expect(args.p_provider).toBe('openrouter')
    expect(args.p_ciphertext).toMatch(/^\\x[0-9a-f]+$/)
    expect(JSON.stringify(args)).not.toContain('abcdefgh')
    const plain = await decryptSecret(
      MASTER,
      'user-1',
      'openrouter',
      fromPgBytea(args.p_ciphertext),
      fromPgBytea(args.p_iv),
    )
    expect(plain).toBe('sk-or-v1-abcdefgh1234')
  })

  it('rejects an OpenRouter key that OpenRouter says is wrong', async () => {
    handler = () => json({ error: { code: 401 } }, 401)
    const res = await save('openrouter', 'sk-or-v1-wrongwrong')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_key' })
    expect(calls.some((c) => c.url.hostname === 'x.supabase.co')).toBe(false)
  })

  it('rejects unknown providers and malformed keys', async () => {
    handler = () => json(null, 201)
    expect((await save('gemini', 'aaaaaaaaaaaa')).status).toBe(404)
    expect((await save('opencode-zen', 'short')).status).toBe(400)
    expect((await save('opencode-zen', 'has space in it')).status).toBe(400)
  })
})

describe('chat proxy', () => {
  const stored = async (key: string) => {
    const { ciphertext, iv } = await encryptSecret(MASTER, 'user-1', 'openrouter', key)
    return [{ ciphertext: toPgBytea(ciphertext), iv: toPgBytea(iv), key_version: 1 }]
  }
  const chat = (body = '{"model":"m","stream":true}') =>
    call('/api/ai/openrouter/chat', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
    })

  it('adds the decrypted key and streams the upstream response back', async () => {
    const rows = await stored('sk-or-v1-realkey9999')
    handler = (c) =>
      c.url.pathname === '/rest/v1/rpc/provider_secret'
        ? json(rows)
        : new Response('data: {"choices":[]}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          })
    const res = await chat()
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    expect(await res.text()).toBe('data: {"choices":[]}\n\n')
    const upstream = calls.find((c) => c.url.hostname === 'openrouter.ai')
    expect(upstream?.url.pathname).toBe('/api/v1/chat/completions')
    expect(upstream?.headers.get('Authorization')).toBe('Bearer sk-or-v1-realkey9999')
    expect(upstream?.body).toBe('{"model":"m","stream":true}')
  })

  it('passes provider errors through with their status', async () => {
    const rows = await stored('sk-or-v1-realkey9999')
    handler = (c) =>
      c.url.hostname === 'x.supabase.co'
        ? json(rows)
        : json({ error: { message: 'no credits' } }, 402)
    const res = await chat()
    expect(res.status).toBe(402)
  })

  it('says no_key when nothing is saved', async () => {
    handler = () => json([])
    const res = await chat()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'no_key' })
  })

  it('refuses oversized bodies before touching the database', async () => {
    const res = await call('/api/ai/openrouter/chat', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Length': String(9 * 1024 * 1024) },
    })
    expect(res.status).toBe(413)
    expect(calls).toHaveLength(0)
  })
})
