import type { ApiError } from '@writey/shared'
import { supabase } from './supabase'

/** Calls the Writey Worker with the current Supabase session attached. */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  let { data } = await supabase.auth.getSession()
  // Proactively refresh if the token expires within 30 seconds
  if (data.session?.expires_at && data.session.expires_at * 1000 < Date.now() + 30_000) {
    const refreshed = await supabase.auth.refreshSession().catch(() => null)
    if (refreshed?.data?.session) data = refreshed.data
  }
  const makeHeaders = (token?: string) => {
    const headers = new Headers(init.headers)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    return headers
  }
  let res = await fetch(`/api${path}`, {
    ...init,
    headers: makeHeaders(data.session?.access_token),
  })
  if (res.status === 401 && data.session) {
    // Retry once with a freshly refreshed session
    const refreshed = await supabase.auth.refreshSession().catch(() => null)
    if (refreshed?.data?.session) {
      res = await fetch(`/api${path}`, {
        ...init,
        headers: makeHeaders(refreshed.data.session.access_token),
      })
    }
  }
  return res
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

export async function errorFrom(res: Response): Promise<ApiRequestError> {
  const body = (await res
    .json()
    .catch(() => ({ error: res.statusText || String(res.status) }))) as ApiError
  const msg =
    typeof body?.error === 'string' && body.error
      ? body.error
      : res.statusText || String(res.status)
  return new ApiRequestError(res.status, msg)
}

/** JSON request to the Worker; throws ApiRequestError on a non-2xx response. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authedFetch(path, init)
  if (!res.ok) throw await errorFrom(res)
  return (await res.json()) as T
}
