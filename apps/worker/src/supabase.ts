export type SupabaseEnv = { SUPABASE_URL: string; SUPABASE_PUBLISHABLE_KEY: string }

/**
 * Calls PostgREST as the signed-in user. Row-level security does the ownership
 * checks, so the Worker never needs the service-role key for user data.
 */
export function rest(
  env: SupabaseEnv,
  token: string,
  path: string,
  init: RequestInit & { prefer?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('apikey', env.SUPABASE_PUBLISHABLE_KEY)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body) headers.set('Content-Type', 'application/json')
  if (init.prefer) headers.set('Prefer', init.prefer)
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { ...init, headers })
}

/** GETs rows; throws on a PostgREST error so callers can return 502. */
export async function select<T>(env: SupabaseEnv, token: string, path: string): Promise<T[]> {
  const res = await rest(env, token, path)
  if (!res.ok) throw new Error(`PostgREST ${res.status}: ${await res.text()}`)
  return (await res.json()) as T[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Ids go into PostgREST filters, so anything that isn't a UUID is rejected up front. */
export const isUuid = (s: string): boolean => UUID.test(s)
