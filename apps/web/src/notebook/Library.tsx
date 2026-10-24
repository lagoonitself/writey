import type { Session } from '@supabase/supabase-js'
import type { NotebookRow } from '@writey/shared'
import { useEffect, useState } from 'react'
import { createNotebook, listNotebooks, renameNotebook, trashNotebook } from '../lib/db'
import { navigate } from '../lib/router'
import { supabase } from '../lib/supabase'

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

  return (
    <div className="library">
      <header className="library-header">
        <h1>Writey</h1>
        <span className="muted">{session.user.email}</span>
        <button type="button" className="ghost" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </header>
      {error && <p className="error">{error}</p>}
      <div className="notebook-grid">
        <button type="button" className="notebook-card new" onClick={create} disabled={creating}>
          {creating ? 'Creating…' : '+ New notebook'}
        </button>
        {notebooks?.map((nb) => (
          <div key={nb.id} className="notebook-card">
            <button type="button" className="notebook-open" onClick={() => navigate(`/n/${nb.id}`)}>
              <span className="notebook-title">{nb.title}</span>
              <span className="muted">{new Date(nb.created_at).toLocaleDateString()}</span>
            </button>
            <span className="notebook-actions">
              <button type="button" className="ghost" onClick={() => rename(nb)}>
                Rename
              </button>
              <button type="button" className="ghost" onClick={() => remove(nb)}>
                Delete
              </button>
            </span>
          </div>
        ))}
      </div>
      {notebooks === null && !error && <p className="muted">Loading…</p>}
    </div>
  )
}
