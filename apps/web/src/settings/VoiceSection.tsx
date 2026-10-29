import { useCallback, useEffect, useState } from 'react'
import { ask } from '../lib/dialogs'
import {
  formatBytes,
  type ModelStatus,
  missingBytes,
  onVoice,
  type VoiceStatus,
  voicePrepare,
  voiceRemoveModels,
  voiceSay,
  voiceSetPrefer,
  voiceStatus,
} from '../lib/voice'
import { CheckIcon, DownloadIcon } from '../notebook/icons'
import { loadVoicePrefs, saveVoicePrefs } from '../voice/useVoice'
import { VoiceGuide } from '../voice/VoiceGuide'

const ACCEL_NAME = { cuda: 'NVIDIA GPU (CUDA)', coreml: 'Apple GPU (CoreML)', cpu: 'CPU' } as const

function describe(m: ModelStatus): { text: string; ok: boolean } {
  switch (m.state) {
    case 'ready':
      return { text: `Ready · ${m.device === 'gpu' ? 'GPU' : 'CPU'}`, ok: true }
    case 'downloaded':
      return { text: 'Downloaded', ok: true }
    case 'downloading':
      return { text: `Downloading ${Math.round(m.progress * 100)}%`, ok: false }
    case 'loading':
      return { text: 'Loading…', ok: false }
    case 'error':
      return { text: `Failed: ${m.error}`, ok: false }
    default:
      return { text: formatBytes(m.bytes), ok: false }
  }
}

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number
  title: string
  done: boolean
  children?: React.ReactNode
}) {
  return (
    <li className={`voice-step${done ? ' done' : ''}`}>
      <span className="voice-step-n" aria-hidden="true">
        {done ? <CheckIcon size={14} /> : n}
      </span>
      <div>
        <p className="voice-step-title">{title}</p>
        {children}
      </div>
    </li>
  )
}

/** Settings → Voice: local speech models, on the GPU when there is one (HANDOFF D57). */
export function VoiceSection() {
  const [prefs, setPrefs] = useState(loadVoicePrefs)
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setStatus(await voiceStatus().catch(() => null))
  }, [])

  useEffect(() => {
    void refresh()
    const off = onVoice('voice:models', setStatus)
    return () => void off.then((f) => f())
  }, [refresh])

  // Download progress isn't an event of its own; poll while busy.
  const busy = Boolean(
    status &&
      [status.engine, status.stt, status.tts].some(
        (m) => m && (m.state === 'downloading' || m.state === 'loading'),
      ),
  )
  useEffect(() => {
    if (!busy) return
    const t = window.setInterval(() => void refresh(), 800)
    return () => window.clearInterval(t)
  }, [busy, refresh])

  const update = (next: typeof prefs) => {
    setPrefs(next)
    saveVoicePrefs(next)
  }

  const download = async () => {
    setError(null)
    try {
      setStatus(await voicePrepare({ stt: true, tts: true }))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const setPrefer = async (prefer: 'auto' | 'cpu') => {
    setStatus(await voiceSetPrefer(prefer))
  }

  const remove = async () => {
    if (!(await ask('Delete the downloaded speech models? You can download them again later.')))
      return
    setStatus(await voiceRemoveModels())
  }

  if (!status) {
    return (
      <section className="settings-section">
        <h3 className="settings-title">Voice</h3>
        <p className="note">Checking this computer…</p>
      </section>
    )
  }
  if (!status.available) {
    return (
      <section className="settings-section">
        <h3 className="settings-title">Voice</h3>
        <p className="note">Voice isn’t part of this build of Writey.</p>
      </section>
    )
  }

  const stt = describe(status.stt)
  const tts = describe(status.tts)
  const engine = status.engine && describe(status.engine)
  const missing = missingBytes(status)
  const allOk = stt.ok && tts.ok && (!engine || engine.ok)
  const gpu = status.accel !== 'cpu'

  return (
    <>
      <section className="settings-section">
        <h3 className="settings-title">Voice</h3>
        <p className="section-sub">
          Talk to Writey while you write, no clicking. Speech runs on this computer, so no audio
          leaves it.
        </p>
        <div className={`now-using${gpu ? ' ready' : ''}`}>
          <span className="now-using-text">
            <small>Speech runs on</small>
            <strong>{ACCEL_NAME[status.accel]}</strong>
            {status.gpu_name && <span>{status.gpu_name}</span>}
          </span>
          {status.prefer === 'cpu' ? (
            <button type="button" onClick={() => setPrefer('auto')}>
              Use the GPU
            </button>
          ) : (
            gpu && (
              <button type="button" className="link-btn" onClick={() => setPrefer('cpu')}>
                Use the CPU instead
              </button>
            )
          )}
        </div>
        {status.gpu_error && <p className="inline-error">{status.gpu_error}</p>}
        <ol className="voice-steps">
          <Step n={1} title="Download the speech models" done={allOk}>
            <dl className="voice-models">
              {engine && status.engine && (
                <>
                  <dt>Speech engine {status.accel === 'cuda' ? '(CUDA for your GPU)' : ''}</dt>
                  <dd className={engine.ok ? 'ok' : ''}>{engine.text}</dd>
                </>
              )}
              <dt>
                Understanding you (Parakeet, English
                {status.accel === 'cpu' ? ', compact' : ', full precision'})
              </dt>
              <dd className={stt.ok ? 'ok' : ''}>{stt.text}</dd>
              <dt>Writey’s voice (Kokoro)</dt>
              <dd className={tts.ok ? 'ok' : ''}>{tts.text}</dd>
            </dl>
            {missing > 0 && !busy && (
              <button type="button" className="primary" onClick={() => void download()}>
                <DownloadIcon size={16} />
                Download (about {formatBytes(missing)}, once)
              </button>
            )}
            {!missing && !busy && !allOk && (
              <button type="button" onClick={() => void download()}>
                Load the models
              </button>
            )}
            {error && <p className="inline-error">{error}</p>}
          </Step>
          <Step
            n={2}
            title="Click the mic under the page and say “Hey, …”"
            done={status.listening}
          />
        </ol>
        {allOk && (
          <button type="button" className="link-btn" onClick={() => void remove()}>
            Delete the speech models
          </button>
        )}
      </section>

      <section className="settings-section">
        <div className="section-head">
          <h3>Talk back</h3>
        </div>
        <label className="switch-row">
          <span>
            Writey answers out loud
            <small>A short spoken answer; the details stay on the page and beside it.</small>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={prefs.replies}
            onChange={(e) => update({ ...prefs, replies: e.target.checked })}
          />
        </label>
        {prefs.replies && (
          <div className="voice-row">
            <select
              value={prefs.voice}
              onChange={(e) => update({ ...prefs, voice: e.target.value })}
              aria-label="Voice"
            >
              {status.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            {status.tts.state === 'ready' && (
              <button
                type="button"
                onClick={() =>
                  void voiceSay("Hi, I'm Writey. Say hey when you want a hand.", prefs.voice)
                }
              >
                Hear it
              </button>
            )}
          </div>
        )}
      </section>

      <section className="settings-section">
        <div className="section-head">
          <h3>What to say</h3>
        </div>
        <VoiceGuide />
      </section>
    </>
  )
}
