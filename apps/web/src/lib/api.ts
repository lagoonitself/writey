import type { ApiError } from '@writey/shared'
import { supabase } from './supabase'

/** Calls the Writey Worker with the current Supabase session attached. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession()
  const headers = new Headers(init.headers)
  if (data.session) headers.set('Authorization', `Bearer ${data.session.access_token}`)
  const res = await fetch(`/api${path}`, { ...init, headers })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as ApiError
    throw new Error(body.error)
  }
  return (await res.json()) as T
}
