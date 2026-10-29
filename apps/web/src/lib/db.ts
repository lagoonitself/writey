import type { NotebookRow, PageBackground, PageRow } from '@writey/shared'
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'
import { call } from './native'

// Notebooks and pages live on this computer, in Writey's own database (apps/desktop/src/store).

export const A4 = { width: 595, height: 842 }

export const listNotebooks = () => call<NotebookRow[]>('notebooks_list')

export const getNotebook = (id: string) => call<NotebookRow | null>('notebook_get', { id })

/** New notebooks go first in the library and start with one blank A4 page. */
export const createNotebook = (firstKey: string | null, title?: string) =>
  call<NotebookRow>('notebook_create', {
    sortKey: generateKeyBetween(null, firstKey),
    pageKey: generateKeyBetween(null, null),
    title: title ?? null,
  })

export const renameNotebook = (id: string, title: string) =>
  call<void>('notebook_rename', { id, title })

/** Moves a notebook to the trash; it stays restorable for 30 days. */
export const trashNotebook = (id: string) => call<void>('notebook_trash', { id })

export const restoreNotebook = (id: string) => call<void>('notebook_restore', { id })

export const listPages = (notebookId: string) => call<PageRow[]>('pages_list', { notebookId })

export type NewPage = { width: number; height: number; background: PageBackground }

/** Inserts pages between two sort keys (null = start/end), in order. */
export async function addPages(
  notebookId: string,
  afterKey: string | null,
  beforeKey: string | null,
  pages: NewPage[],
): Promise<PageRow[]> {
  const keys = generateNKeysBetween(afterKey, beforeKey, pages.length)
  return call<PageRow[]>('pages_add', {
    notebookId,
    pages: pages.map((p, i) => ({ ...p, sort_key: keys[i] })),
  })
}

export const movePage = (id: string, sortKey: string) => call<void>('page_move', { id, sortKey })

export const trashPage = (id: string) => call<void>('page_trash', { id })

/** Sort keys for `n` notebooks placed before the current first one. */
export function keysBefore(firstKey: string | null, n: number): string[] {
  return n > 0 ? generateNKeysBetween(null, firstKey, n) : []
}
