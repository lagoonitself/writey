import { keysBefore, listNotebooks } from './db'
import { call } from './native'

// `.writey` files: backups and notebooks moved between computers (apps/desktop/src/store/archive.rs).

export type ImportSummary = { notebooks: number; pages: number; first_id: string | null }

/** Writes notebooks (all when `ids` is empty) to `path`; returns how many. */
export const exportNotebooks = (path: string, ids: string[] = []) =>
  call<number>('archive_export', { path, ids })

/** Adds the notebooks in a `.writey` file at the top of the library. */
export async function importNotebooks(path: string): Promise<ImportSummary> {
  const count = await call<number>('archive_peek', { path })
  const first = (await listNotebooks())[0]?.sort_key ?? null
  return call<ImportSummary>('archive_import', { path, sortKeys: keysBefore(first, count) })
}

export const openDataFolder = () => call<void>('data_folder_open')
