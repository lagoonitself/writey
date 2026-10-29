import { generateNKeysBetween } from 'fractional-indexing'
import * as desktop from './desktop/db'
import { isDesktop } from './native'
import * as web from './web/db'

// Notebooks and pages: on this computer in the desktop app, in Supabase on the website.
const impl = isDesktop() ? desktop : web

export const A4 = { width: 595, height: 842 }
export type { NewPage } from './web/db'

export const listNotebooks: typeof web.listNotebooks = () => impl.listNotebooks()
export const getNotebook: typeof web.getNotebook = (id) => impl.getNotebook(id)
export const createNotebook: typeof web.createNotebook = (firstKey) => impl.createNotebook(firstKey)
export const renameNotebook: typeof web.renameNotebook = (id, title) =>
  impl.renameNotebook(id, title)
export const trashNotebook: typeof web.trashNotebook = (id) => impl.trashNotebook(id)
export const listPages: typeof web.listPages = (id) => impl.listPages(id)
export const addPages: typeof web.addPages = (...a) => impl.addPages(...a)
export const movePage: typeof web.movePage = (id, key) => impl.movePage(id, key)
export const trashPage: typeof web.trashPage = (id) => impl.trashPage(id)

/** Brings a trashed notebook back (desktop; the website deletes for good). */
export async function restoreNotebook(id: string): Promise<boolean> {
  if (!isDesktop()) return false
  await desktop.restoreNotebook(id)
  return true
}

/** Sort keys for `n` notebooks placed before the current first one. */
export function keysBefore(firstKey: string | null, n: number): string[] {
  return n > 0 ? generateNKeysBetween(null, firstKey, n) : []
}
