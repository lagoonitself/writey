import type { Session } from '@supabase/supabase-js'
import type { NotebookRow } from '@writey/shared'
import { useEffect, useRef, useState } from 'react'
import { createNotebook, listNotebooks, renameNotebook, trashNotebook } from '../lib/db'
import { navigate } from '../lib/router'
import { supabase } from '../lib/supabase'
import { SettingsDialog } from '../settings/SettingsDialog'
import { takeOpenSettingsFlag, useAiState } from '../settings/useAiState'
import { EditIcon, GearIcon, PlusIcon, SignOutIcon, TrashIcon } from './icons'

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

export function Library({ session }: { session: Session }) {
  const [notebooks, setNotebooks] = useState<NotebookRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [ai, setAi] = useAiState()
  const [settingsOpen, setSettingsOpen] = useState(takeOpenSettingsFlag)

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

  const fullName = session.user.user_metadata?.full_name as string | undefined
  const name = fullName?.split(' ')[0] ?? session.user.email?.split('@')[0] ?? ''
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
        <AccountMenu session={session} name={fullName ?? name} />
      </header>

      <section className="library-hero">
        <div>
          <h1>
            {greeting()}, <em>{name}</em>.
          </h1>
          <p>
            {notebooks === null
              ? 'Fetching your notebooks…'
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
      {settingsOpen && (
        <SettingsDialog ai={ai} onChange={setAi} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  )
}

function AccountMenu({ session, name }: { session: Session; name: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const picture = session.user.user_metadata?.avatar_url as string | undefined

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

  return (
    <div className="account" ref={ref}>
      <button
        type="button"
        className="avatar-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account"
      >
        {picture ? (
          <img src={picture} alt="" referrerPolicy="no-referrer" />
        ) : (
          (name.charAt(0) || '?').toUpperCase()
        )}
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-who">
            <strong>{name}</strong>
            <span>{session.user.email}</span>
          </div>
          <button type="button" role="menuitem" onClick={() => supabase.auth.signOut()}>
            <SignOutIcon size={17} />
            Sign out
          </button>
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
