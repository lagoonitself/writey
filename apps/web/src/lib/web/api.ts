import type { ApiError } from '@writey/shared'
import { supabase } from './supabase'

/** Calls the Writey Worker with the current Supabase session attached. */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession()
  const headers = new Headers(init.headers)
  if (data.session) headers.set('Authorization', `Bearer ${data.session.access_token}`)
  return fetch(`/api${path}`, { ...init, headers })
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function errorFrom(res: Response): Promise<ApiRequestError> {
  const body = (await res.json().catch(() => ({ error: res.statusText }))) as ApiError
  return new ApiRequestError(res.status, body.error)
}

/** JSON request to the Worker; throws ApiRequestError on a non-2xx response. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authedFetch(path, init)
  if (!res.ok) throw await errorFrom(res)
  return (await res.json()) as T
}
