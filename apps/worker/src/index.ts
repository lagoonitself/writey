import type { ApiError, HealthResponse, MeResponse } from '@writey/shared'
import { Hono } from 'hono'
import { type AuthUser, supabaseJwks, verifySupabaseToken } from './auth'

type Env = { SUPABASE_URL: string }
type Vars = { user: AuthUser }

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
  await next()
})

app.get('/me', (c) => c.json<MeResponse>(c.get('user')))

app.notFound((c) => c.json<ApiError>({ error: 'not_found' }, 404))

export default app
