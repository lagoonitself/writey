import { open, save } from '@tauri-apps/plugin-dialog'
import { useState } from 'react'
import { exportNotebooks, importNotebooks, openDataFolder } from '../lib/archive'

/** Settings → Notebooks: backups and moving notebooks between computers. */
export function DataSection() {
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
    <section className="settings-section">
      <h3 className="settings-title">Notebooks</h3>
      <p className="section-sub">
        Your notebooks are saved on this computer as you write. A backup is one <code>.writey</code>{' '}
        file with every page, PDF, picture and conversation; open it in Writey on another Windows PC
        or Mac.
      </p>
      <div className="actions">
        <button type="button" className="primary" onClick={backup} disabled={busy}>
          Back up all notebooks…
        </button>
        <button type="button" onClick={restore} disabled={busy}>
          Import a .writey file…
        </button>
      </div>
      <p className="section-sub">
        Coming from the Writey website? Open{' '}
        <a
          href="https://writey.writey.workers.dev/export"
          target="_blank"
          rel="noopener noreferrer"
        >
          writey.writey.workers.dev/export
        </a>
        , sign in, download your notebooks, then import the file here.
      </p>
      <div className="actions">
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
  )
}
