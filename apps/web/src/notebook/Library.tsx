import { open, save } from '@tauri-apps/plugin-dialog'
import type { NotebookRow } from '@writey/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { exportNotebooks, importNotebooks } from '../lib/archive'
import {
  createNotebook,
  listNotebooks,
  renameNotebook,
  restoreNotebook,
  trashNotebook,
} from '../lib/db'
import { call } from '../lib/native'
import { navigate } from '../lib/router'
import { SettingsDialog } from '../settings/SettingsDialog'
import { useAiState } from '../settings/useAiState'
import { EditIcon, GearIcon, PlusIcon, TrashIcon } from './icons'

/** Book-cloth colors: muted, so the pages stay the brightest thing on screen. */
const COVERS = ['#2b3a67', '#7e2e2b', '#2f5a48', '#a8772a', '#4f3a63', '#2c2b29', '#3f5f7a']

/** A stable cover color per notebook, so each one is recognizable at a glance. */
function coverFor(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return COVERS[h % COVERS.length] as string
}

function greeting(): string {
  const h = new Date().getHours()
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

type AppInfo = { version: string; user_name: string | null }

export function Library() {
  const [notebooks, setNotebooks] = useState<NotebookRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [ai, setAi] = useAiState()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [undo, setUndo] = useState<NotebookRow | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const undoTimer = useRef(0)

  const load = useCallback(
    () =>
      listNotebooks()
        .then(setNotebooks)
        .catch((e: Error) => setError(e.message)),
    [],
  )

  useEffect(() => {
    void load()
    call<AppInfo>('app_info')
      .then(setInfo)
      .catch(() => {})
    // A .writey file opened from Explorer or Finder lands here.
    const onImported = () => void load()
    window.addEventListener('writey-imported', onImported)
    return () => window.removeEventListener('writey-imported', onImported)
  }, [load])

  const create = async () => {
    setCreating(true)
    try {
      const nb = await createNotebook(notebooks?.[0]?.sort_key ?? null)
      navigate(`/n/${nb.id}`)
    } catch (e) {
      setError((e as Error).message)
      setCreating(false)
    }
  }

  const rename = async (nb: NotebookRow, title: string) => {
    setEditing(null)
    title = title.trim()
    if (!title || title === nb.title) return
    try {
      await renameNotebook(nb.id, title)
      setNotebooks((prev) => prev?.map((n) => (n.id === nb.id ? { ...n, title } : n)) ?? null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const remove = async (nb: NotebookRow) => {
    try {
      await trashNotebook(nb.id)
      setNotebooks((prev) => prev?.filter((n) => n.id !== nb.id) ?? null)
      setUndo(nb)
      window.clearTimeout(undoTimer.current)
      undoTimer.current = window.setTimeout(() => setUndo(null), 8000)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const restore = async () => {
    if (!undo) return
    const nb = undo
    setUndo(null)
    await restoreNotebook(nb.id).catch((e: Error) => setError(e.message))
    void load()
  }

  const importFile = async () => {
    const path = await open({
      title: 'Import notebooks',
      multiple: false,
      filters: [{ name: 'Writey notebooks', extensions: ['writey'] }],
    })
    if (typeof path !== 'string') return
    try {
      await importNotebooks(path)
      void load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const backup = async () => {
    const path = await save({
      title: 'Back up all notebooks',
      defaultPath: `Writey notebooks ${new Date().toISOString().slice(0, 10)}.writey`,
      filters: [{ name: 'Writey notebooks', extensions: ['writey'] }],
    })
    if (!path) return
    await exportNotebooks(path).catch((e: Error) => setError(e.message))
  }

  const name = info?.user_name ?? ''
  const count = notebooks?.length ?? 0

  return (
    <div className="library">
      <header className="topbar">
        <Wordmark />
        <button
          type="button"
          className="ghost icon-btn"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          aria-label="Settings"
        >
          <GearIcon size={19} />
        </button>
        <LibraryMenu onImport={importFile} onBackup={backup} version={info?.version} />
      </header>

      <section className="library-hero">
        <div>
          <h1>
            {greeting()}
            {name ? (
              <>
                , <em>{name}</em>.
              </>
            ) : (
              '.'
            )}
          </h1>
          <p>
            {notebooks === null
              ? 'Opening your notebooks…'
              : count === 0
                ? 'Nothing here yet. Start a notebook and write the first line.'
                : `${count} notebook${count === 1 ? '' : 's'}. Pick up where you left off.`}
          </p>
        </div>
      </section>

      {error && <p className="inline-error">{error}</p>}
      <div className="notebook-grid">
        <button type="button" className="notebook-card new" onClick={create} disabled={creating}>
          <span className="new-plus">
            <PlusIcon size={26} />
          </span>
          {creating ? 'Opening a fresh one…' : 'New notebook'}
        </button>
        {notebooks === null &&
          !error &&
          [0, 1, 2].map((i) => <div key={i} className="notebook-skeleton" aria-hidden="true" />)}
        {notebooks?.map((nb, i) => (
          <div
            key={nb.id}
            className="notebook-card"
            style={{ '--cover': coverFor(nb.id), '--i': i } as React.CSSProperties}
          >
            {editing === nb.id ? (
              <form
                className="notebook-open notebook-rename"
                onSubmit={(e) => {
                  e.preventDefault()
                  const input = e.currentTarget.elements.namedItem('title') as HTMLInputElement
                  void rename(nb, input.value)
                }}
              >
                <input
                  name="title"
                  className="field"
                  defaultValue={nb.title}
                  aria-label="Notebook name"
                  // biome-ignore lint/a11y/noAutofocus: renaming starts typing right away
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={(e) => void rename(nb, e.currentTarget.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
                  maxLength={200}
                />
              </form>
            ) : (
              <button
                type="button"
                className="notebook-open"
                onClick={() => navigate(`/n/${nb.id}`)}
              >
                <span className="notebook-label">
                  <span className="notebook-title">{nb.title}</span>
                  <span className="notebook-date">
                    {new Date(nb.updated_at).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </span>
                </span>
              </button>
            )}
            <span className="notebook-actions">
              <button
                type="button"
                onClick={() => setEditing(nb.id)}
                title="Rename"
                aria-label={`Rename ${nb.title}`}
              >
                <EditIcon size={15} />
              </button>
              <button
                type="button"
                onClick={() => void remove(nb)}
                title="Delete"
                aria-label={`Delete ${nb.title}`}
              >
                <TrashIcon size={15} />
              </button>
            </span>
          </div>
        ))}
      </div>
      {undo && (
        <div className="undo-toast" role="status">
          Deleted “{undo.title}”.
          <button type="button" onClick={() => void restore()}>
            Undo
          </button>
        </div>
      )}
      {settingsOpen && (
        <SettingsDialog ai={ai} onChange={setAi} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  )
}

function LibraryMenu({
  onImport,
  onBackup,
  version,
}: {
  onImport(): void
  onBackup(): void
  version?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }

  return (
    <div className="account" ref={ref}>
      <button
        type="button"
        className="ghost icon-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        title="More"
      >
        <span aria-hidden="true" className="dots">
          ⋯
        </span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" onClick={pick(onImport)}>
            Import notebooks…
          </button>
          <button type="button" role="menuitem" onClick={pick(onBackup)}>
            Back up all notebooks…
          </button>
          {version && <div className="menu-who">Writey {version}</div>}
        </div>
      )}
    </div>
  )
}

/** The logo: the name with a hand-drawn underline that writes itself in. */
export function Wordmark() {
  return (
    <span className="wordmark">
      Writey
      <svg viewBox="0 0 120 14" aria-hidden="true">
        <path d="M3 9c18-5 40-7 62-5 16 1.5 30 3 52-1" pathLength={1} />
      </svg>
    </span>
  )
}
