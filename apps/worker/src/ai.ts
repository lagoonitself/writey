import {
  AI_BODY_MAX_BYTES,
  type ApiError,
  type CredentialInfo,
  isKeyProvider,
  KEY_MAX_LENGTH,
  type KeyProvider,
  type SaveCredentialBody,
} from '@writey/shared'
import { Hono } from 'hono'
import type { AuthUser } from './auth'
import { decryptSecret, encryptSecret, fromPgBytea, KEY_VERSION, toPgBytea } from './crypto'
import { rest, type SupabaseEnv, select } from './supabase'

export type AiEnv = SupabaseEnv & { CREDENTIALS_KEY: string }
type Vars = { user: AuthUser; token: string }

// Requests only ever go to these URLs; the client picks a provider, never a host.
const UPSTREAM: Record<KeyProvider, { chat: string; models: string }> = {
  openrouter: {
    chat: 'https://openrouter.ai/api/v1/chat/completions',
    models: 'https://openrouter.ai/api/v1/models?input_modalities=image',
  },
  'opencode-zen': {
    chat: 'https://opencode.ai/inference/openai/v1/chat/completions',
    models: 'https://opencode.ai/zen/v1/models',
  },
}

const CREDENTIAL_COLUMNS = 'provider,label,last4,created_at'

export const ai = new Hono<{ Bindings: AiEnv; Variables: Vars }>()

// ---------------------------------------------------------------------------
// Provider keys (docs §6.2). The browser sends a key once; it comes back only as last4.
// ---------------------------------------------------------------------------

ai.get('/credentials', async (c) =>
  c.json(
    await select<CredentialInfo>(
      c.env,
      c.get('token'),
      `provider_credentials?select=${CREDENTIAL_COLUMNS}&order=provider`,
    ),
  ),
)

ai.put('/credentials/:provider', async (c) => {
  const provider = c.req.param('provider')
  if (!isKeyProvider(provider)) return c.json<ApiError>({ error: 'bad_provider' }, 404)
  if (!c.env.CREDENTIALS_KEY) throw new Error('CREDENTIALS_KEY is not set')
  if (Number(c.req.header('Content-Length')) > 4096) {
    return c.json<ApiError>({ error: 'too_large' }, 413)
  }
  const body = (await c.req.json().catch(() => null)) as SaveCredentialBody | null
  const key = typeof body?.key === 'string' ? body.key.trim() : ''
  if (key.length < 8 || key.length > KEY_MAX_LENGTH || /\s/.test(key)) {
    return c.json<ApiError>({ error: 'bad_key' }, 400)
  }
  const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 60) || null : null
  if (provider === 'openrouter' && !(await openRouterKeyWorks(key))) {
    return c.json<ApiError>({ error: 'invalid_key' }, 400)
  }

  const user = c.get('user')
  const { ciphertext, iv } = await encryptSecret(c.env.CREDENTIALS_KEY, user.userId, provider, key)
  const last4 = key.slice(-4)
  // Clients can't write the table directly; this function upserts as the signed-in user.
  const res = await rest(c.env, c.get('token'), 'rpc/save_provider_secret', {
    method: 'POST',
    body: JSON.stringify({
      p_provider: provider,
      p_label: label,
      p_ciphertext: toPgBytea(ciphertext),
      p_iv: toPgBytea(iv),
      p_key_version: KEY_VERSION,
      p_last4: last4,
    }),
  })
  if (!res.ok) throw new Error(`credential save failed: ${res.status} ${await res.text()}`)
  const created = (await res.json()) as string
  return c.json<CredentialInfo>({ provider, label, last4, created_at: created })
})

ai.delete('/credentials/:provider', async (c) => {
  const provider = c.req.param('provider')
  if (!isKeyProvider(provider)) return c.json<ApiError>({ error: 'bad_provider' }, 404)
  const res = await rest(c.env, c.get('token'), `provider_credentials?provider=eq.${provider}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`credential delete failed: ${res.status}`)
  return c.body(null, 204)
})

/** A clear 401 means the key is wrong. Anything else (an outage) doesn't block saving. */
async function openRouterKeyWorks(key: string): Promise<boolean> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
    })
    return res.status !== 401
  } catch {
    return true
  }
}

async function providerKey(
  env: AiEnv,
  token: string,
  userId: string,
  provider: KeyProvider,
): Promise<string | 'no_key' | 'key_unreadable'> {
  const res = await rest(env, token, 'rpc/provider_secret', {
    method: 'POST',
    body: JSON.stringify({ p_provider: provider }),
  })
  if (!res.ok) throw new Error(`provider_secret failed: ${res.status}`)
  const [row] = (await res.json()) as { ciphertext: string; iv: string }[]
  if (!row) return 'no_key'
  const key = await decryptSecret(
    env.CREDENTIALS_KEY,
    userId,
    provider,
    fromPgBytea(row.ciphertext),
    fromPgBytea(row.iv),
  )
  return key ?? 'key_unreadable'
}

// ---------------------------------------------------------------------------
// Model calls. Bodies pass through unparsed and responses stream straight back,
// which keeps the Worker inside the free plan's CPU budget (docs §8).
// ---------------------------------------------------------------------------

ai.get('/ai/:provider/models', async (c) => {
  const provider = c.req.param('provider')
  if (!isKeyProvider(provider)) return c.json<ApiError>({ error: 'bad_provider' }, 404)
  const upstream = await fetch(UPSTREAM[provider].models, {
    cf: { cacheTtl: 3600, cacheEverything: true },
  } as RequestInit)
  if (!upstream.ok) return c.json<ApiError>({ error: 'upstream_error' }, 502)
  return new Response(upstream.body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=3600' },
  })
})

ai.post('/ai/:provider/chat', async (c) => {
  const provider = c.req.param('provider')
  if (!isKeyProvider(provider)) return c.json<ApiError>({ error: 'bad_provider' }, 404)
  const length = Number(c.req.header('Content-Length'))
  if (!length) return c.json<ApiError>({ error: 'length_required' }, 411)
  if (length > AI_BODY_MAX_BYTES) return c.json<ApiError>({ error: 'too_large' }, 413)

  const key = await providerKey(c.env, c.get('token'), c.get('user').userId, provider)
  if (key === 'no_key' || key === 'key_unreadable') return c.json<ApiError>({ error: key }, 400)

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = new URL(c.req.url).origin
    headers['X-Title'] = 'Writey'
  }
  // Buffered rather than streamed so the upstream gets a Content-Length; copying bytes
  // is cheap, it's JSON parsing that the CPU limit forbids.
  const upstream = await fetch(UPSTREAM[provider].chat, {
    method: 'POST',
    headers,
    body: await c.req.arrayBuffer(),
    signal: c.req.raw.signal,
  })
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': 'no-store',
    },
  })
})
