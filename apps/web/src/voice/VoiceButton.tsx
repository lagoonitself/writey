import { useState } from 'react'
import { MicIcon, MicOffIcon } from '../notebook/icons'
import type { VoiceState } from './client'
import { PTT_LABEL, type Voice } from './useVoice'

const LABEL: Record<VoiceState['kind'], string> = {
  off: 'Voice',
  starting: 'Starting…',
  models: 'Getting voice ready…',
  listening: 'Listening',
  hearing: 'Hearing you…',
  transcribing: 'Listening…',
  paused: 'Voice paused',
  error: 'Voice off',
}

/** The mic toggle in the notebook header, with what Writey heard and its questions. */
export function VoiceButton({ voice, onSettings }: { voice: Voice; onSettings(): void }) {
  const { state } = voice
  const [showError, setShowError] = useState(true)
  const on = !['off', 'paused', 'error'].includes(state.kind)
  let label = voice.speaking ? 'Speaking' : LABEL[state.kind]
  if (state.kind === 'models' && state.progress !== null) {
    label = `Downloading voice ${Math.round(state.progress * 100)}%`
  }
  const hint = on
    ? `Say "Writey, …" or hold ${PTT_LABEL} to talk. Click to stop listening.`
    : `Talk to Writey: say "Writey, what's next?", or hold ${PTT_LABEL} while you speak.`

  return (
    <div className="voice">
      <button
        type="button"
        className={`voice-btn ${state.kind}${voice.speaking ? ' speaking' : ''}`}
        onClick={() => {
          if (voice.speaking) voice.stopSpeaking()
          else {
            setShowError(true)
            voice.toggle()
          }
        }}
        title={voice.speaking ? 'Stop speaking' : hint}
        aria-pressed={on}
      >
        {on ? <MicIcon size={17} /> : <MicOffIcon size={17} />}
        <span>{label}</span>
        {on && <span className="voice-dot" aria-hidden="true" />}
      </button>
      {state.kind === 'error' && showError && (
        <div className="voice-pop error" role="alert">
          <p>{state.message}</p>
          <div className="voice-pop-actions">
            {state.fix === 'retry' ? (
              <button type="button" onClick={voice.start}>
                Try again
              </button>
            ) : (
              <button type="button" className="primary" onClick={onSettings}>
                {state.fix === 'update' ? 'Update Writey Helper' : 'Set up Writey Helper'}
              </button>
            )}
            <button type="button" className="ghost" onClick={() => setShowError(false)}>
              Close
            </button>
          </div>
        </div>
      )}
      {voice.confirm !== null && (
        <div className="voice-pop" role="dialog" aria-label="Did you mean Writey?">
          <p>
            Did you mean Writey?
            {voice.confirm && <span className="voice-quote">“{voice.confirm}”</span>}
          </p>
          <div className="voice-pop-actions">
            <button
              type="button"
              className="primary"
              onClick={() => voice.ask(voice.confirm || "What's next?")}
            >
              Ask Writey
            </button>
            <button type="button" className="ghost" onClick={voice.dismissConfirm}>
              No
            </button>
          </div>
        </div>
      )}
      {voice.heard && voice.confirm === null && state.kind !== 'error' && (
        <p className="voice-heard" aria-live="polite">
          “{voice.heard}”
        </p>
      )}
    </div>
  )
}
