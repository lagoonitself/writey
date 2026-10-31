import type { NotebookRow, PageBackground, PageRow } from '@writey/shared'
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'
import { broadcastMessage } from './broadcast'
import { supabase } from './supabase'

// Notebook and page metadata go straight to Supabase; RLS limits rows to the owner.
// Ink content goes through the Worker (see pageStore.ts).

const NOTEBOOK_COLUMNS = 'id,title,sort_key,created_at,updated_at'
const PAGE_COLUMNS = 'id,notebook_id,sort_key,width,height,background,version'

export const A4 = { width: 595, height: 842 }

function check<T>(res: { data: unknown; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data as T
}

export async function listNotebooks(): Promise<NotebookRow[]> {
  return check(
    await supabase
      .from('notebooks')
      .select(NOTEBOOK_COLUMNS)
      .is('deleted_at', null)
      .order('sort_key'),
  )
}

export async function getNotebook(id: string): Promise<NotebookRow | null> {
  return check(
    await supabase
      .from('notebooks')
      .select(NOTEBOOK_COLUMNS)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle(),
  )
}

/** New notebooks go first in the library and start with one blank A4 page. */
export async function createNotebook(firstKey: string | null): Promise<NotebookRow> {
  const notebook = check<NotebookRow>(
    await supabase
      .from('notebooks')
      .insert({ sort_key: generateKeyBetween(null, firstKey) })
      .select(NOTEBOOK_COLUMNS)
      .single(),
  )
  await addPages(notebook.id, null, null, [{ ...A4, background: { kind: 'blank' } }])
  broadcastMessage({ type: 'notebooks_changed' })
  return notebook
}

export async function renameNotebook(id: string, title: string): Promise<void> {
  check(await supabase.from('notebooks').update({ title }).eq('id', id))
  broadcastMessage({ type: 'notebooks_changed' })
}

export async function trashNotebook(id: string): Promise<void> {
  check(
    await supabase.from('notebooks').update({ deleted_at: new Date().toISOString() }).eq('id', id),
  )
  broadcastMessage({ type: 'notebooks_changed' })
}

export async function restoreNotebook(id: string): Promise<boolean> {
  const { error } = await supabase.from('notebooks').update({ deleted_at: null }).eq('id', id)
  if (error) return false
  broadcastMessage({ type: 'notebooks_changed' })
  return true
}

export async function listPages(notebookId: string): Promise<PageRow[]> {
  return check(
    await supabase
      .from('pages')
      .select(PAGE_COLUMNS)
      .eq('notebook_id', notebookId)
      .is('deleted_at', null)
      .order('sort_key'),
  )
}

export type NewPage = { width: number; height: number; background: PageBackground }

/** Inserts pages between two sort keys (null = start/end), in order. */
export async function addPages(
  notebookId: string,
  afterKey: string | null,
  beforeKey: string | null,
  pages: NewPage[],
): Promise<PageRow[]> {
  const keys = generateNKeysBetween(afterKey, beforeKey, pages.length)
  const rows = check<PageRow[]>(
    await supabase
      .from('pages')
      .insert(pages.map((p, i) => ({ ...p, notebook_id: notebookId, sort_key: keys[i] })))
      .select(PAGE_COLUMNS),
  )
  broadcastMessage({ type: 'pages_changed', notebookId })
  return rows.sort((a, b) => (a.sort_key < b.sort_key ? -1 : 1))
}

export async function movePage(id: string, sortKey: string): Promise<void> {
  check(await supabase.from('pages').update({ sort_key: sortKey }).eq('id', id))
}

export async function trashPage(id: string): Promise<void> {
  check(await supabase.from('pages').update({ deleted_at: new Date().toISOString() }).eq('id', id))
}
