import { useCallback, useEffect, useState } from 'react'
import {
  HELPER_SETUP_FILE,
  type HelperState,
  type ModelStatus,
  synthesize,
  type VoiceStatus,
  voiceHelperState,
  voicePrepare,
  voiceStatus,
} from '../lib/helper'
import { CheckIcon, DownloadIcon } from '../notebook/icons'
import { loadVoicePrefs, saveVoicePrefs } from '../voice/useVoice'
import { VoiceGuide } from '../voice/VoiceGuide'

const VOICE_NAMES: Record<string, string> = {
  af_heart: 'Heart (US)',
  af_bella: 'Bella (US)',
  af_nicole: 'Nicole (US)',
  am_michael: 'Michael (US)',
  am_fenrir: 'Fenrir (US)',
  bf_emma: 'Emma (UK)',
  bm_george: 'George (UK)',
}

/** Download sizes. Both models are larger (and much faster) on an NVIDIA GPU. */
const SIZE = { cuda: { stt: '1.3 GB', tts: '340 MB' }, cpu: { stt: '660 MB', tts: '120 MB' } }
const WHERE = { cuda: 'GPU', cpu: 'CPU' }

function describe(m: ModelStatus, size: string): { text: string; ok: boolean } {
  switch (m.state) {
    case 'ready':
      return { text: `Ready · ${WHERE[m.device ?? 'cpu']}`, ok: true }
    case 'downloaded':
      return { text: 'Downloaded', ok: true }
    case 'downloading':
      return { text: `Downloading ${Math.round((m.progress ?? 0) * 100)}%`, ok: false }
    case 'loading':
      return { text: 'Loading…', ok: false }
    case 'error':
      return { text: 'Failed, try again', ok: false }
    default:
      return { text: size, ok: false }
  }
}

const busy = (s: VoiceStatus | null) =>
  Boolean(s && [s.stt, s.tts].some((m) => m.state === 'downloading' || m.state === 'loading'))

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

/** Settings → Voice: local speech models in Writey Helper (docs §7). */
export function VoiceSection() {
  const [prefs, setPrefs] = useState(loadVoicePrefs)
  const [helper, setHelper] = useState<HelperState | null>(null)
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [sample, setSample] = useState(false)
  const [checked, setChecked] = useState(false)

  const refresh = useCallback(async () => {
    const h = await voiceHelperState()
    setHelper(h)
    if (h === 'ok') setStatus(await voiceStatus().catch(() => null))
  }, [])

  // Talking to 127.0.0.1 makes Chrome ask about local network access, so only on request.
  useEffect(() => {
    if (checked) void refresh()
  }, [checked, refresh])

  useEffect(() => {
    if (!busy(status)) return
    const t = window.setTimeout(() => void refresh(), 1200)
    return () => window.clearTimeout(t)
  }, [status, refresh])

  const update = (next: typeof prefs) => {
    setPrefs(next)
    saveVoicePrefs(next)
  }

  const download = async () => {
    setStatus(await voicePrepare({ stt: true, tts: true }).catch(() => status))
  }

  const playSample = async () => {
    setSample(true)
    try {
      const wav = await synthesize("Hi, I'm Writey. Say my name when you want a hand.", prefs.voice)
      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
      const audio = new Audio(url)
      audio.onended = () => URL.revokeObjectURL(url)
      await audio.play()
    } catch (e) {
      console.error('sample failed', e)
    } finally {
      setSample(false)
    }
  }

  const size = SIZE[status?.device ?? 'cpu']
  const stt = status && describe(status.stt, size.stt)
  const tts = status && describe(status.tts, size.tts)
  const helperOk = helper === 'ok'
  const modelsOk = Boolean(stt?.ok && tts?.ok)
  const missing =
    status && [status.stt, status.tts].some((m) => m.state === 'missing' || m.state === 'error')

  return (
    <>
      <section className="settings-section">
        <h3 className="settings-title">Voice</h3>
        <p className="section-sub">
          Talk to Writey while you write, no clicking. Speech runs on this computer in Writey
          Helper, so no audio leaves it.
        </p>

        {!checked ? (
          <button type="button" className="primary" onClick={() => setChecked(true)}>
            Set up voice on this computer
          </button>
        ) : (
          <ol className="voice-steps">
            <Step n={1} title="Install Writey Helper" done={helperOk}>
              {helper === null ? (
                <p className="note">Looking for Writey Helper…</p>
              ) : !helperOk ? (
                <>
                  <p className="note">
                    {helper === 'outdated'
                      ? 'An older version is installed. Run the setup again to update it.'
                      : 'A small free app that runs the speech models. Run the downloaded file once; it starts with Windows after that.'}
                  </p>
                  <div className="voice-row">
                    <a
                      className="btn primary"
                      href={HELPER_SETUP_FILE}
                      download="writey-helper-setup.cmd"
                    >
                      <DownloadIcon size={16} />
                      {helper === 'outdated' ? 'Update Writey Helper' : 'Download Writey Helper'}
                    </a>
                    <button type="button" onClick={() => void refresh()}>
                      I’ve run it, check again
                    </button>
                  </div>
                </>
              ) : (
                <p className="note">Running on this computer.</p>
              )}
            </Step>
            <Step n={2} title="Download the speech models" done={helperOk && modelsOk}>
              {helperOk && status && stt && tts && (
                <>
                  <dl className="voice-models">
                    <dt>Understanding you (Parakeet, English)</dt>
                    <dd className={stt.ok ? 'ok' : ''}>{stt.text}</dd>
                    <dt>Writey’s voice (Kokoro)</dt>
                    <dd className={tts.ok ? 'ok' : ''}>{tts.text}</dd>
                  </dl>
                  {missing && (
                    <button type="button" className="primary" onClick={() => void download()}>
                      <DownloadIcon size={16} />
                      Download (about {status.device === 'cuda' ? '1.6 GB' : '780 MB'}, once)
                    </button>
                  )}
                </>
              )}
            </Step>
            <Step n={3} title="Click the mic under the page and say “Hey, …”" done={false} />
          </ol>
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
              {Object.entries(VOICE_NAMES).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            {status?.tts.state === 'ready' && (
              <button type="button" onClick={playSample} disabled={sample}>
                {sample ? 'Playing…' : 'Hear it'}
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
