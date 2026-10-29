import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { call } from './native'

// The desktop app's Writey account: signing in syncs its notebooks with the website.

export type AccountStatus = {
  signed_in: boolean
  email: string | null
  /** "off" (not signed in), "idle", "syncing" or "error". */
  state: 'off' | 'idle' | 'syncing' | 'error'
  last_synced_at: string | null
  error: string | null
}

export type SyncReport = {
  pulled: number
  pushed: number
  pages: string[]
  conflicts: string[]
  lists_changed: boolean
}

export const accountStatus = () => call<AccountStatus>('account_status')
/** Opens the Google sign-in in the browser; resolves when it comes back. */
export const accountLogin = () => call<AccountStatus>('account_login')
export const accountCancelLogin = () => call<void>('account_cancel_login')
export const accountLogout = () => call<AccountStatus>('account_logout')
export const syncNow = () => call<void>('sync_now')

export const onSyncStatus = (f: (s: AccountStatus) => void): Promise<UnlistenFn> =>
  listen<AccountStatus>('sync:status', (e) => f(e.payload))

export const onSynced = (f: (r: SyncReport) => void): Promise<UnlistenFn> =>
  listen<SyncReport>('sync:changed', (e) => f(e.payload))
