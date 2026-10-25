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
import { DownloadIcon } from '../notebook/icons'
import { loadVoicePrefs, PTT_LABEL, saveVoicePrefs } from '../voice/useVoice'

const VOICE_NAMES: Record<string, string> = {
  af_heart: 'Heart (US)',
  af_bella: 'Bella (US)',
  af_nicole: 'Nicole (US)',
  am_michael: 'Michael (US)',
  am_fenrir: 'Fenrir (US)',
  bf_emma: 'Emma (UK)',
  bm_george: 'George (UK)',
}

const SIZE = { stt: '660 MB', tts: '120 MB' }

function describe(m: ModelStatus, size: string): { text: string; ok: boolean } {
  switch (m.state) {
    case 'ready':
      return { text: 'Ready', ok: true }
    case 'downloaded':
      return { text: 'Downloaded', ok: true }
    case 'downloading':
      return { text: `Downloading ${Math.round((m.progress ?? 0) * 100)}%`, ok: false }
    case 'loading':
      return { text: 'Loading…', ok: false }
    case 'error':
      return { text: 'Failed, try again', ok: false }
    default:
      return { text: `Not downloaded (${size})`, ok: false }
  }
}

const busy = (s: VoiceStatus | null) =>
  Boolean(s && [s.stt, s.tts].some((m) => m.state === 'downloading' || m.state === 'loading'))

/** Settings → Voice: local speech models in Writey Helper (docs §7). */
export function VoiceSection() {
  const [prefs, setPrefs] = useState(loadVoicePrefs)
  const [helper, setHelper] = useState<HelperState | null>(null)
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [sample, setSample] = useState(false)

  const refresh = useCallback(async () => {
    const h = await voiceHelperState()
    setHelper(h)
    if (h === 'ok') setStatus(await voiceStatus().catch(() => null))
  }, [])

  const [checked, setChecked] = useState(false)
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

  const stt = status && describe(status.stt, SIZE.stt)
  const tts = status && describe(status.tts, SIZE.tts)
  const missing =
    status && [status.stt, status.tts].some((m) => m.state === 'missing' || m.state === 'error')

  return (
    <section className="settings-section">
      <div className="section-head">
        <h3>Voice</h3>
      </div>
      <p className="section-sub">
        Say “Writey, what’s next?” or hold <kbd>{PTT_LABEL}</kbd> while you speak. Speech runs on
        this computer in Writey Helper; no audio leaves it.
      </p>
      <div className="voice-settings">
        {!checked ? (
          <div className="voice-row">
            <button type="button" onClick={() => setChecked(true)}>
              Check voice on this computer
            </button>
          </div>
        ) : helper === null ? (
          <p className="note">Checking Writey Helper…</p>
        ) : helper !== 'ok' ? (
          <>
            <p>
              {helper === 'outdated'
                ? 'The Writey Helper on this computer is an older version without voice. Download the setup again to update it.'
                : 'Voice needs Writey Helper, a small free app that runs the speech models on this computer.'}
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
                Check again
              </button>
            </div>
          </>
        ) : (
          status &&
          stt &&
          tts && (
            <>
              <dl className="voice-models">
                <dt>Speech recognition (Parakeet)</dt>
                <dd className={stt.ok ? 'ok' : ''}>{stt.text}</dd>
                <dt>Spoken replies (Kokoro)</dt>
                <dd className={tts.ok ? 'ok' : ''}>{tts.text}</dd>
              </dl>
              {missing && (
                <div className="voice-row">
                  <button type="button" className="primary" onClick={() => void download()}>
                    <DownloadIcon size={16} />
                    Download voice models
                  </button>
                </div>
              )}
            </>
          )
        )}
        <div className="voice-row">
          <label>
            <input
              type="checkbox"
              checked={prefs.replies}
              onChange={(e) => update({ ...prefs, replies: e.target.checked })}
            />
            Speak Writey’s replies
          </label>
          <select
            value={prefs.voice}
            onChange={(e) => update({ ...prefs, voice: e.target.value })}
            aria-label="Voice"
            disabled={!prefs.replies}
          >
            {Object.entries(VOICE_NAMES).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          {prefs.replies && status?.tts.state === 'ready' && (
            <button type="button" className="link-btn" onClick={playSample} disabled={sample}>
              Play a sample
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
