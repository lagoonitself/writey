import { open, save } from '@tauri-apps/plugin-dialog'
import { useEffect, useState } from 'react'
import {
  type AccountStatus,
  accountCancelLogin,
  accountLogin,
  accountLogout,
  accountStatus,
  onSyncStatus,
  syncNow,
} from '../lib/account'
import { exportNotebooks, importNotebooks, openDataFolder } from '../lib/archive'
import { isDesktop } from '../lib/native'
import { exportEverything } from '../site/exporter'

const RELEASES = 'https://github.com/lagoonitself/writey/releases/latest'

/** Settings → Notebooks: sync between the app and the website, backups, moving notebooks. */
export function DataSection() {
  return isDesktop() ? <DesktopData /> : <WebData />
}

function when(iso: string | null): string {
  if (!iso) return 'not yet'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function SyncCard() {
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void accountStatus().then(setStatus)
    const off = onSyncStatus(setStatus)
    const t = window.setInterval(() => void accountStatus().then(setStatus), 15_000)
    return () => {
      void off.then((f) => f())
      window.clearInterval(t)
    }
  }, [])

  const signIn = async () => {
    setError(null)
    setWaiting(true)
    try {
      setStatus(await accountLogin())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setWaiting(false)
    }
  }

  if (!status) return null
  if (waiting) {
    return (
      <div className="setup">
        <span className="waiting">
          <span className="spinner" aria-hidden="true" />
          Finish signing in with Google in your browser.
        </span>
        <div className="actions">
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              void accountCancelLogin()
              setWaiting(false)
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }
  if (!status.signed_in) {
    return (
      <>
        <p className="section-sub">
          Sign in with the Google account you use on the Writey website. Your notebooks then stay
          the same here, on the website and on your other computers; this computer keeps working
          offline and catches up when it’s back online.
        </p>
        <button type="button" className="primary" onClick={signIn}>
          Sign in to sync
        </button>
        {error && <p className="inline-error">{error}</p>}
      </>
    )
  }
  return (
    <>
      <div className="account-line">
        <span>
          Syncing as <strong>{status.email ?? 'your Writey account'}</strong>
        </span>
      </div>
      <p className="note">
        {status.state === 'syncing'
          ? 'Syncing…'
          : status.state === 'error'
            ? `Last sync failed: ${status.error}`
            : `Up to date · synced ${when(status.last_synced_at)}`}
      </p>
      <div className="actions">
        <button type="button" onClick={() => void syncNow()}>
          Sync now
        </button>
        <button
          type="button"
          className="link-btn"
          onClick={async () => setStatus(await accountLogout())}
        >
          Sign out
        </button>
      </div>
    </>
  )
}

function DesktopData() {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null)

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true)
    setNote(null)
    try {
      const text = await fn()
      if (text) setNote({ text })
    } catch (e) {
      setNote({ text: (e as Error).message, error: true })
    } finally {
      setBusy(false)
    }
  }

  const backup = () =>
    run(async () => {
      const path = await save({
        title: 'Back up all notebooks',
        defaultPath: `Writey notebooks ${new Date().toISOString().slice(0, 10)}.writey`,
        filters: [{ name: 'Writey notebooks', extensions: ['writey'] }],
      })
      if (!path) return null
      const n = await exportNotebooks(path)
      return `Saved ${n} notebook${n === 1 ? '' : 's'}.`
    })

  const restore = () =>
    run(async () => {
      const path = await open({
        title: 'Import notebooks',
        multiple: false,
        filters: [{ name: 'Writey notebooks', extensions: ['writey'] }],
      })
      if (typeof path !== 'string') return null
      const r = await importNotebooks(path)
      return `Imported ${r.notebooks} notebook${r.notebooks === 1 ? '' : 's'} (${r.pages} pages). They’re at the top of your library.`
    })

  return (
    <>
      <section className="settings-section">
        <h3 className="settings-title">Sync</h3>
        <SyncCard />
      </section>
      <section className="settings-section">
        <div className="section-head">
          <h3>Backups</h3>
        </div>
        <p className="section-sub">
          Notebooks are saved on this computer as you write. A backup is one <code>.writey</code>{' '}
          file with every page, PDF, picture and conversation.
        </p>
        <div className="actions">
          <button type="button" onClick={backup} disabled={busy}>
            Back up all notebooks…
          </button>
          <button type="button" onClick={restore} disabled={busy}>
            Import a .writey file…
          </button>
          <button type="button" className="link-btn" onClick={() => void openDataFolder()}>
            Show Writey’s data folder
          </button>
        </div>
        {note && (
          <p className={note.error ? 'inline-error' : 'note'} role="status">
            {note.text}
          </p>
        )}
      </section>
    </>
  )
}

function WebData() {
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const download = async () => {
    setBusy(true)
    try {
      const blob = await exportEverything(setStatus)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `Writey notebooks ${new Date().toISOString().slice(0, 10)}.writey`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000)
      setStatus('Downloaded.')
    } catch (e) {
      setStatus((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <section className="settings-section">
        <h3 className="settings-title">Notebooks</h3>
        <p className="section-sub">
          Your notebooks are saved in your Writey account. In the Writey app for Windows or Mac,
          sign in with this Google account (Settings → Notebooks) and they sync both ways; the app
          also works offline and talks with you on your own GPU.
        </p>
        <div className="actions">
          <a className="btn primary" href={RELEASES} target="_blank" rel="noopener noreferrer">
            Get the desktop app
          </a>
          <button type="button" onClick={download} disabled={busy}>
            {busy ? 'Packing…' : 'Download all notebooks'}
          </button>
        </div>
        {status && <p className="note">{status}</p>}
      </section>
    </>
  )
}
