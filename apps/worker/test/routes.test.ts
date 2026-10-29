import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/auth', () => ({
  supabaseJwks: () => null,
  verifySupabaseToken: async (token: string) =>
    token === 'good' ? { userId: 'user-1', email: 'a@b.c' } : null,
}))

const { default: app } = await import('../src/index')

const PAGE = '11111111-1111-4111-8111-111111111111'

/** Minimal in-memory R2 bucket. */
function fakeR2() {
  const store = new Map<string, { bytes: Uint8Array; contentType?: string }>()
  return {
    store,
    async put(
      key: string,
      body: ReadableStream | Uint8Array,
      opts?: { httpMetadata?: { contentType?: string } },
    ) {
      const bytes =
        body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer())
      store.set(key, { bytes, contentType: opts?.httpMetadata?.contentType })
    },
    async get(key: string) {
      const o = store.get(key)
      if (!o) return null
      return {
        body: new Blob([o.bytes]).stream(),
        httpMetadata: { contentType: o.contentType },
        httpEtag: '"e"',
      }
    },
    async delete(key: string) {
      store.delete(key)
    },
  }
}

type Rest = { method: string; url: URL; body: unknown }
let r2: ReturnType<typeof fakeR2>
let restCalls: Rest[]
let restHandler: (call: Rest) => Response
const pending: Promise<unknown>[] = []
const ctx = {
  waitUntil: (p: Promise<unknown>) => pending.push(p),
  passThroughOnException() {},
  props: {},
}

const env = () => ({
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'pk',
  FILES: r2,
})
const json = (data: unknown, status = 200) => Response.json(data, { status })

async function call(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer good')
  const res = await app.request(
    path,
    { ...init, headers },
    env(),
    ctx as unknown as ExecutionContext,
  )
  await Promise.all(pending.splice(0))
  return res
}

const put = (version: number, bytes = new Uint8Array([1, 2, 3])) =>
  call(`/api/pages/${PAGE}/content`, {
    method: 'PUT',
    body: bytes,
    headers: { 'X-Page-Version': String(version), 'Content-Length': String(bytes.length) },
  })

beforeEach(() => {
  r2 = fakeR2()
  restCalls = []
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const c = {
      method: init.method ?? 'GET',
      url: new URL(input),
      body: init.body ? JSON.parse(String(init.body)) : null,
    }
    restCalls.push(c)
    return restHandler(c)
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('auth', () => {
  it('rejects requests without a valid token', async () => {
    const res = await call(`/api/pages/${PAGE}/content`, {
      headers: { Authorization: 'Bearer bad' },
    })
    expect(res.status).toBe(401)
  })
})

describe('page content', () => {
  it('GET returns 204 and the version when the page has no ink yet', async () => {
    restHandler = () => json([{ version: 0, content_key: null }])
    const res = await call(`/api/pages/${PAGE}/content`)
    expect(res.status).toBe(204)
    expect(res.headers.get('X-Page-Version')).toBe('0')
    expect(restCalls[0]?.url.searchParams.get('id')).toBe(`eq.${PAGE}`)
  })

  it('GET 404s for non-uuid ids without touching the database', async () => {
    const res = await call('/api/pages/1;drop/content')
    expect(res.status).toBe(404)
    expect(restCalls).toHaveLength(0)
  })

  it('PUT stores the blob and bumps the version with a compare-and-set', async () => {
    restHandler = (c) =>
      c.method === 'PATCH' ? json([{ version: 1 }]) : json([{ version: 0, content_key: null }])
    const res = await put(0)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: 1 })
    const patch = restCalls.find((c) => c.method === 'PATCH')
    expect(patch?.url.searchParams.get('version')).toBe('eq.0')
    const key = (patch?.body as { content_key: string } | undefined)?.content_key
    expect(key).toMatch(new RegExp(`^u/user-1/pages/${PAGE}/1-`))
    expect([...r2.store.keys()]).toEqual([key])

    // and the blob reads back
    restHandler = () => json([{ version: 1, content_key: key }])
    const got = await call(`/api/pages/${PAGE}/content`)
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('PUT deletes the previous blob after a successful save', async () => {
    await r2.put('old-key', new Uint8Array([9]))
    restHandler = (c) =>
      c.method === 'PATCH' ? json([{ version: 4 }]) : json([{ version: 3, content_key: 'old-key' }])
    expect((await put(3)).status).toBe(200)
    expect(r2.store.has('old-key')).toBe(false)
    expect(r2.store.size).toBe(1)
  })

  it('PUT with a stale version returns 409 and writes nothing', async () => {
    restHandler = () => json([{ version: 5, content_key: 'k' }])
    const res = await put(2)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'version_conflict', version: 5 })
    expect(r2.store.size).toBe(0)
  })

  it('PUT that loses a race returns 409 and removes its orphan blob', async () => {
    let reads = 0
    restHandler = (c) => {
      if (c.method === 'PATCH') return json([])
      reads++
      return json([{ version: reads === 1 ? 0 : 1, content_key: null }])
    }
    const res = await put(0)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'version_conflict', version: 1 })
    expect(r2.store.size).toBe(0)
  })

  it('PUT rejects oversized bodies', async () => {
    const res = await call(`/api/pages/${PAGE}/content`, {
      method: 'PUT',
      body: new Uint8Array([1]),
      headers: { 'X-Page-Version': '0', 'Content-Length': String(6 * 1024 * 1024) },
    })
    expect(res.status).toBe(413)
  })
})

describe('assets', () => {
  const sha = 'a'.repeat(64)
  const upload = (kind: string, type: string, headers: Record<string, string> = {}) =>
    call(`/api/assets?kind=${kind}`, {
      method: 'POST',
      body: new Uint8Array([1, 2]),
      headers: { 'Content-Type': type, 'Content-Length': '2', 'X-Content-Sha256': sha, ...headers },
    })

  it('rejects a mismatched content type', async () => {
    expect((await upload('pdf', 'image/png', { 'X-Page-Count': '1' })).status).toBe(415)
  })

  it('requires a page count for PDFs', async () => {
    expect((await upload('pdf', 'application/pdf')).status).toBe(400)
  })

  it('stores the file and inserts the row', async () => {
    restHandler = (c) => json([{ ...(c.body as object), created_at: 'now' }], 201)
    const res = await upload('image', 'image/png')
    expect(res.status).toBe(201)
    const row = (await res.json()) as { id: string; bytes: number }
    expect(row.bytes).toBe(2)
    expect(r2.store.get(`u/user-1/assets/${row.id}`)?.contentType).toBe('image/png')
  })

  it('keeps an id the desktop app chose', async () => {
    const id = '22222222-2222-4222-8222-222222222222'
    restHandler = (c) =>
      c.method === 'GET' ? json([]) : json([{ ...(c.body as object), created_at: 'now' }], 201)
    const res = await upload('image', 'image/png', { 'X-Asset-Id': id })
    expect(res.status).toBe(201)
    expect(((await res.json()) as { id: string }).id).toBe(id)
    expect(r2.store.has(`u/user-1/assets/${id}`)).toBe(true)
  })

  it('returns the existing row for an id already uploaded', async () => {
    const id = '22222222-2222-4222-8222-222222222222'
    restHandler = () => json([{ id, kind: 'image', bytes: 2 }])
    const res = await upload('image', 'image/png', { 'X-Asset-Id': id })
    expect(res.status).toBe(200)
    expect(r2.store.size).toBe(0)
  })

  it('refuses a bad id', async () => {
    expect((await upload('image', 'image/png', { 'X-Asset-Id': 'x' })).status).toBe(400)
  })

  it('cleans up the blob if the row insert fails', async () => {
    restHandler = () => json({ message: 'nope' }, 400)
    const res = await upload('image', 'image/png')
    expect(res.status).toBe(500)
    expect(r2.store.size).toBe(0)
  })
})

describe('picture proxy', () => {
  it('only fetches from Wikimedia Commons', async () => {
    restHandler = () => new Response('x')
    for (const url of ['http://upload.wikimedia.org/a.png', 'https://evil.example/a.png', 'nope']) {
      const res = await call(`/api/picture?url=${encodeURIComponent(url)}`)
      expect(res.status).toBe(400)
    }
    expect(restCalls).toHaveLength(0)
  })

  it('streams an image through', async () => {
    restHandler = () => new Response('png', { headers: { 'Content-Type': 'image/png' } })
    const url =
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Heart.svg/960px-Heart.svg.png'
    const res = await call(`/api/picture?url=${encodeURIComponent(url)}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(await res.text()).toBe('png')
    expect(restCalls[0]?.url.hostname).toBe('upload.wikimedia.org')
  })

  it('refuses what is not an image', async () => {
    restHandler = () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } })
    const url = 'https://upload.wikimedia.org/x'
    expect((await call(`/api/picture?url=${encodeURIComponent(url)}`)).status).toBe(502)
  })
})
