import { decodePage, emptyPage, encodePage, gunzip, gzip, type PageDoc } from '@writey/ink-engine'
import { PAGE_VERSION_HEADER, type VersionConflict } from '@writey/shared'
import { del, get, set } from 'idb-keyval'
import { authedFetch, errorFrom } from './api'

// Page ink is saved through the Worker to R2. A copy of unsaved work is kept in
// IndexedDB so a crash or closed tab doesn't lose it (docs §4.5).

type Backup = { json: string; baseVersion: number; at: number }
const backupKey = (pageId: string) => `page-backup:${pageId}`

export type LoadedPage = { doc: PageDoc; version: number; restored: boolean }

export async function loadPage(pageId: string): Promise<LoadedPage> {
  const res = await authedFetch(`/pages/${pageId}/content`)
  if (!res.ok) throw await errorFrom(res)
  const version = Number(res.headers.get(PAGE_VERSION_HEADER) ?? 0)
  const backup = await get<Backup>(backupKey(pageId)).catch(() => undefined)
  if (backup?.baseVersion === version) {
    // Unsaved edits made on top of exactly this version: restore them.
    return { doc: decodePage(backup.json), version, restored: true }
  }
  if (backup) {
    console.warn(
      `Dropping stale local copy of page ${pageId} (based on v${backup.baseVersion}, server has v${version})`,
    )
    await del(backupKey(pageId)).catch(() => {})
  }
  const doc = res.status === 204 ? emptyPage() : decodePage(await gunzip(await res.arrayBuffer()))
  return { doc, version, restored: false }
}

export type SaveResult = { ok: true; version: number } | { ok: false; conflictVersion: number }

export async function savePage(
  pageId: string,
  doc: PageDoc,
  baseVersion: number,
): Promise<SaveResult> {
  const body = await gzip(encodePage(doc))
  const res = await authedFetch(`/pages/${pageId}/content`, {
    method: 'PUT',
    body: body as BodyInit,
    headers: {
      [PAGE_VERSION_HEADER]: String(baseVersion),
      'Content-Type': 'application/octet-stream',
    },
    // Lets a save started while the tab is closing finish (browsers cap this at 64 KB).
    keepalive: body.byteLength < 60_000,
  })
  if (res.status === 409) {
    const conflict = (await res.json()) as VersionConflict
    return { ok: false, conflictVersion: conflict.version }
  }
  if (!res.ok) throw await errorFrom(res)
  return { ok: true, version: ((await res.json()) as { version: number }).version }
}

export function backupPage(pageId: string, doc: PageDoc, baseVersion: number): Promise<void> {
  const backup: Backup = { json: encodePage(doc), baseVersion, at: Date.now() }
  return set(backupKey(pageId), backup)
}

export function clearBackup(pageId: string): Promise<void> {
  return del(backupKey(pageId))
}
