import { decodePage, emptyPage, encodePage, gunzip, gzip, type PageDoc } from '@writey/ink-engine'
import { del, get, set } from 'idb-keyval'
import { callBytes, callForBytes } from '../native'

// Page ink is saved gzipped in Writey's database on this computer. A copy of unsaved work
// is kept in IndexedDB so a crash doesn't lose it (docs §4.5).

type Backup = { json: string; baseVersion: number; at: number }
const backupKey = (pageId: string) => `page-backup:${pageId}`

export type LoadedPage = { doc: PageDoc; version: number; restored: boolean }

export async function loadPage(pageId: string): Promise<LoadedPage> {
  // The first 8 bytes are the version (little-endian), the rest the gzipped ink.
  const bytes = await callForBytes('page_load', { id: pageId })
  const version = Number(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true))
  const content = bytes.subarray(8)
  const backup = await get<Backup>(backupKey(pageId)).catch(() => undefined)
  if (backup?.baseVersion === version) {
    // Unsaved edits made on top of exactly this version: restore them.
    return { doc: decodePage(backup.json), version, restored: true }
  }
  if (backup) {
    console.warn(
      `Dropping stale local copy of page ${pageId} (based on v${backup.baseVersion}, saved is v${version})`,
    )
    await del(backupKey(pageId)).catch(() => {})
  }
  const doc = content.length === 0 ? emptyPage() : decodePage(await gunzip(content))
  return { doc, version, restored: false }
}

export type SaveResult = { ok: true; version: number } | { ok: false; conflictVersion: number }

export async function savePage(
  pageId: string,
  doc: PageDoc,
  baseVersion: number,
): Promise<SaveResult> {
  const body = await gzip(encodePage(doc))
  return callBytes<SaveResult>('page_save', body, {
    'x-page-id': pageId,
    'x-base-version': String(baseVersion),
  })
}

export function backupPage(pageId: string, doc: PageDoc, baseVersion: number): Promise<void> {
  const backup: Backup = { json: encodePage(doc), baseVersion, at: Date.now() }
  return set(backupKey(pageId), backup)
}

export function clearBackup(pageId: string): Promise<void> {
  return del(backupKey(pageId))
}
