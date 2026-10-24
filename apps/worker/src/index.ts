import {
  type ApiError,
  ASSET_MAX_BYTES,
  ASSET_MIME,
  type AssetKind,
  type AssetRow,
  type HealthResponse,
  type MeResponse,
  PAGE_MAX_BYTES,
  PAGE_VERSION_HEADER,
  type VersionConflict,
} from '@writey/shared'
import { Hono } from 'hono'
import { type AuthUser, supabaseJwks, verifySupabaseToken } from './auth'
import { isUuid, rest, type SupabaseEnv, select } from './supabase'

export type Env = SupabaseEnv & { FILES: R2Bucket }
type Vars = { user: AuthUser; token: string }

const app = new Hono<{ Bindings: Env; Variables: Vars }>().basePath('/api')

app.get('/health', (c) =>
  c.json<HealthResponse>({ ok: true, service: 'writey-worker', time: new Date().toISOString() }),
)

// Everything below requires a signed-in user.
app.use('*', async (c, next) => {
  const header = c.req.header('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const user = token
    ? await verifySupabaseToken(token, supabaseJwks(c.env.SUPABASE_URL), c.env.SUPABASE_URL)
    : null
  if (!user) return c.json<ApiError>({ error: 'unauthorized' }, 401)
  c.set('user', user)
  c.set('token', token)
  await next()
})

app.get('/me', (c) => c.json<MeResponse>(c.get('user')))

// ---------------------------------------------------------------------------
// Page ink: gzipped JSON in R2, version number in Postgres (docs §4.5)
// ---------------------------------------------------------------------------

type PageHead = { version: number; content_key: string | null }

const pageHead = async (env: Env, token: string, id: string) =>
  (
    await select<PageHead>(
      env,
      token,
      `pages?id=eq.${id}&deleted_at=is.null&select=version,content_key`,
    )
  )[0]

app.get('/pages/:id/content', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json<ApiError>({ error: 'not_found' }, 404)
  const head = await pageHead(c.env, c.get('token'), id)
  if (!head) return c.json<ApiError>({ error: 'not_found' }, 404)
  const headers = { [PAGE_VERSION_HEADER]: String(head.version), 'Cache-Control': 'no-store' }
  const obj = head.content_key ? await c.env.FILES.get(head.content_key) : null
  if (!obj) return new Response(null, { status: 204, headers })
  return new Response(obj.body, {
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
  })
})

app.put('/pages/:id/content', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json<ApiError>({ error: 'not_found' }, 404)
  const base = Number(c.req.header(PAGE_VERSION_HEADER))
  if (!Number.isInteger(base) || base < 0) return c.json<ApiError>({ error: 'bad_version' }, 400)
  const length = Number(c.req.header('Content-Length'))
  if (!length) return c.json<ApiError>({ error: 'length_required' }, 411)
  if (length > PAGE_MAX_BYTES) return c.json<ApiError>({ error: 'too_large' }, 413)
  const body = c.req.raw.body
  if (!body) return c.json<ApiError>({ error: 'empty_body' }, 400)

  const token = c.get('token')
  const head = await pageHead(c.env, token, id)
  if (!head) return c.json<ApiError>({ error: 'not_found' }, 404)
  if (head.version !== base) {
    return c.json<VersionConflict>({ error: 'version_conflict', version: head.version }, 409)
  }

  // Write the new blob under a fresh key first, then move the version pointer with a
  // compare-and-set. A lost race leaves the old blob current and deletes ours.
  const next = base + 1
  const key = `u/${c.get('user').userId}/pages/${id}/${next}-${crypto.randomUUID()}.json.gz`
  await c.env.FILES.put(key, body, { httpMetadata: { contentType: 'application/octet-stream' } })
  const res = await rest(
    c.env,
    token,
    `pages?id=eq.${id}&version=eq.${base}&deleted_at=is.null&select=version`,
    {
      method: 'PATCH',
      body: JSON.stringify({ version: next, content_key: key }),
      prefer: 'return=representation',
    },
  )
  if (!res.ok || ((await res.json()) as unknown[]).length === 0) {
    c.executionCtx.waitUntil(c.env.FILES.delete(key))
    if (!res.ok) throw new Error(`page update failed: ${res.status}`)
    const now = await pageHead(c.env, token, id)
    return c.json<VersionConflict>({ error: 'version_conflict', version: now?.version ?? -1 }, 409)
  }
  if (head.content_key) c.executionCtx.waitUntil(c.env.FILES.delete(head.content_key))
  c.header(PAGE_VERSION_HEADER, String(next))
  return c.json({ version: next })
})

// ---------------------------------------------------------------------------
// Uploaded PDFs and images. Bytes in R2, metadata row in Postgres.
// ---------------------------------------------------------------------------

const ASSET_COLUMNS = 'id,kind,bytes,sha256,page_count,created_at'

app.post('/assets', async (c) => {
  const kind = c.req.query('kind') as AssetKind
  if (kind !== 'pdf' && kind !== 'image') return c.json<ApiError>({ error: 'bad_kind' }, 400)
  const type = (c.req.header('Content-Type') ?? '').split(';')[0]?.trim() ?? ''
  if (!ASSET_MIME[kind].includes(type)) return c.json<ApiError>({ error: 'bad_type' }, 415)
  const length = Number(c.req.header('Content-Length'))
  if (!length) return c.json<ApiError>({ error: 'length_required' }, 411)
  if (length > ASSET_MAX_BYTES[kind]) return c.json<ApiError>({ error: 'too_large' }, 413)
  const sha256 = (c.req.header('X-Content-Sha256') ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(sha256)) return c.json<ApiError>({ error: 'bad_sha256' }, 400)
  let pageCount: number | null = null
  if (kind === 'pdf') {
    pageCount = Number(c.req.header('X-Page-Count'))
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      return c.json<ApiError>({ error: 'bad_page_count' }, 400)
    }
  }
  const body = c.req.raw.body
  if (!body) return c.json<ApiError>({ error: 'empty_body' }, 400)

  const id = crypto.randomUUID()
  const key = `u/${c.get('user').userId}/assets/${id}`
  // R2 rejects the upload if the bytes don't match the declared SHA-256.
  await c.env.FILES.put(key, body, { httpMetadata: { contentType: type }, sha256 })
  const res = await rest(c.env, c.get('token'), `assets?select=${ASSET_COLUMNS}`, {
    method: 'POST',
    body: JSON.stringify({ id, kind, r2_key: key, bytes: length, sha256, page_count: pageCount }),
    prefer: 'return=representation',
  })
  if (!res.ok) {
    c.executionCtx.waitUntil(c.env.FILES.delete(key))
    throw new Error(`asset insert failed: ${res.status} ${await res.text()}`)
  }
  const [row] = (await res.json()) as AssetRow[]
  return c.json(row, 201)
})

app.get('/assets/:id', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json<ApiError>({ error: 'not_found' }, 404)
  const [row] = await select<{ r2_key: string }>(
    c.env,
    c.get('token'),
    `assets?id=eq.${id}&select=r2_key`,
  )
  const obj = row ? await c.env.FILES.get(row.r2_key) : null
  if (!obj) return c.json<ApiError>({ error: 'not_found' }, 404)
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      // Asset bytes never change for a given id.
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: obj.httpEtag,
    },
  })
})

app.notFound((c) => c.json<ApiError>({ error: 'not_found' }, 404))

app.onError((err, c) => {
  console.error(err)
  return c.json<ApiError>({ error: 'server_error' }, 500)
})

export default app
