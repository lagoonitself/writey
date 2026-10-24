import type { Session } from '@supabase/supabase-js'
import type { NotebookRow } from '@writey/shared'
import { useEffect, useState } from 'react'
import { createNotebook, listNotebooks, renameNotebook, trashNotebook } from '../lib/db'
import { navigate } from '../lib/router'
import { supabase } from '../lib/supabase'
import { EditIcon, PlusIcon, TrashIcon } from './icons'

const COVERS = ['#2f4bf0', '#f0304f', '#ffb020', '#0f9d6b', '#7a5cff', '#16171d']

/** A stable cover color per notebook, so each one is recognizable at a glance. */
function coverFor(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return COVERS[h % COVERS.length] as string
}

export function Library({ session }: { session: Session }) {
  const [notebooks, setNotebooks] = useState<NotebookRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    listNotebooks()
      .then(setNotebooks)
      .catch((e: Error) => setError(e.message))
  }, [])

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

  const rename = async (nb: NotebookRow) => {
    const title = prompt('Rename notebook', nb.title)?.trim()
    if (!title || title === nb.title) return
    await renameNotebook(nb.id, title).catch((e: Error) => setError(e.message))
    setNotebooks((prev) => prev?.map((n) => (n.id === nb.id ? { ...n, title } : n)) ?? null)
  }

  const remove = async (nb: NotebookRow) => {
    if (!confirm(`Delete "${nb.title}"?`)) return
    await trashNotebook(nb.id).catch((e: Error) => setError(e.message))
    setNotebooks((prev) => prev?.filter((n) => n.id !== nb.id) ?? null)
  }

  const name =
    (session.user.user_metadata?.full_name as string | undefined)?.split(' ')[0] ??
    session.user.email?.split('@')[0]

  return (
    <div className="library">
      <header className="library-header">
        <Wordmark />
        <span className="user-email">{session.user.email}</span>
        <button type="button" className="ghost" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </header>
      <p className="hello">Hi {name}, what are we writing today?</p>
      {error && <p className="error">{error}</p>}
      <div className="notebook-grid">
        <button type="button" className="notebook-card new" onClick={create} disabled={creating}>
          <span className="new-plus">
            <PlusIcon size={28} />
          </span>
          {creating ? 'Opening a fresh one…' : 'New notebook'}
        </button>
        {notebooks?.map((nb, i) => (
          <div
            key={nb.id}
            className="notebook-card"
            style={{ '--cover': coverFor(nb.id), '--i': i } as React.CSSProperties}
          >
            <button type="button" className="notebook-open" onClick={() => navigate(`/n/${nb.id}`)}>
              <span className="notebook-label">
                <span className="notebook-title">{nb.title}</span>
                <span className="notebook-date">
                  {new Date(nb.created_at).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </span>
              </span>
            </button>
            <span className="notebook-actions">
              <button
                type="button"
                onClick={() => rename(nb)}
                title="Rename"
                aria-label={`Rename ${nb.title}`}
              >
                <EditIcon size={15} />
              </button>
              <button
                type="button"
                onClick={() => remove(nb)}
                title="Delete"
                aria-label={`Delete ${nb.title}`}
              >
                <TrashIcon size={15} />
              </button>
            </span>
          </div>
        ))}
      </div>
      {notebooks === null && !error && <p className="muted loading">Fetching your notebooks…</p>}
      {notebooks?.length === 0 && (
        <p className="empty-hint">Start your first notebook. It's a blank page waiting for you.</p>
      )}
    </div>
  )
}

/** The logo: the name with a hand-drawn underline that writes itself in. */
export function Wordmark({ big = false }: { big?: boolean }) {
  return (
    <span className={`wordmark${big ? ' big' : ''}`}>
      Writey
      <svg viewBox="0 0 120 14" aria-hidden="true">
        <path d="M3 9c18-5 40-7 62-5 16 1.5 30 3 52-1" pathLength={1} />
      </svg>
    </span>
  )
}
