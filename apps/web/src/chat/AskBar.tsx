import { CHATGPT_USAGE_URL } from '@writey/ai-core'
import { useEffect, useState } from 'react'
import { isMac } from '../lib/native'
import { CloseIcon, MicIcon, MicOffIcon, NewChatIcon, SendIcon, StopIcon } from '../notebook/icons'
import { PTT_LABEL, VOICE_ENABLED, type Voice } from '../voice/useVoice'
import { VoiceGuide } from '../voice/VoiceGuide'

const GUIDE_SEEN = 'writey.voiceGuideSeen'

type Props = {
  voice: Voice
  input: string
  onInput(text: string): void
  onSend(text: string): void
  onStop(): void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  /** An answer is on its way; `status` says what Writey is doing. */
  busy: boolean
  status: string | null
  canAsk: boolean
  /** The conversation beside the page. */
  conversationOpen: boolean
  hasConversation: boolean
  onConversation(open: boolean): void
  /** A short note about the last answer, e.g. when it went onto the page only. */
  notice: string | null
  onNotice(): void
  chatgpt: boolean
  onSettings(): void
}

/** What the mic is doing, in a few words, and what you can say next. */
function voiceLine(v: Voice): { label: string; hint: string } {
  const s = v.state
  if (v.speaking) return { label: 'Speaking', hint: 'Talk over Writey to interrupt' }
  switch (s.kind) {
    case 'starting':
      return { label: 'Starting the mic…', hint: '' }
    case 'models':
      return {
        label:
          s.progress === null
            ? 'Getting voice ready…'
            : `Downloading voice · ${Math.round(s.progress * 100)}%`,
        hint: 'Only the first time',
      }
    case 'hearing':
      return { label: 'Hearing you…', hint: '' }
    case 'transcribing':
      return { label: 'Got it…', hint: '' }
    case 'listening':
      return v.replying
        ? { label: 'Your turn', hint: 'Just reply, no need to say “Hey”' }
        : { label: 'Listening', hint: `Say “Hey, …” or hold ${PTT_LABEL}` }
    case 'paused':
      return { label: 'Mic paused', hint: 'Click the mic to listen again' }
    default:
      return { label: '', hint: '' }
  }
}

/** The one place to ask Writey: floating under the page, by voice or by typing. */
const MOD = isMac ? '⌘' : 'Ctrl'

export function AskBar(p: Props) {
  const { voice } = p
  const [guide, setGuide] = useState(false)
  const [showError, setShowError] = useState(true)
  const listening = !['off', 'paused', 'error'].includes(voice.state.kind)
  const line = voiceLine(voice)

  // The first time the mic turns on, show what to say.
  useEffect(() => {
    if (!listening) return
    try {
      if (localStorage.getItem(GUIDE_SEEN)) return
      localStorage.setItem(GUIDE_SEEN, '1')
    } catch {
      return
    }
    setGuide(true)
  }, [listening])

  const status = p.busy ? p.status : listening || voice.speaking ? line.label : null
  const hint = p.busy ? '' : listening || voice.speaking ? line.hint : ''

  return (
    <div className="askbar-wrap">
      {guide && (
        <div className="ask-pop guide" role="dialog" aria-label="How to talk to Writey">
          <header>
            <h3>Talk to Writey</h3>
            <button
              type="button"
              className="ghost icon-btn"
              onClick={() => setGuide(false)}
              aria-label="Close"
            >
              <CloseIcon size={16} />
            </button>
          </header>
          <VoiceGuide
            onTry={(text) => {
              setGuide(false)
              p.onSend(text)
            }}
          />
          {!listening && (
            <button
              type="button"
              className="primary"
              onClick={() => {
                setGuide(false)
                voice.start()
              }}
            >
              <MicIcon size={16} /> Start listening
            </button>
          )}
        </div>
      )}
      {voice.state.kind === 'error' && showError && (
        <div className="ask-pop error" role="alert">
          <p>{voice.state.message}</p>
          <div className="ask-pop-actions">
            {voice.state.fix === 'retry' ? (
              <button type="button" onClick={voice.start}>
                Try again
              </button>
            ) : (
              <button type="button" className="primary" onClick={p.onSettings}>
                Open voice settings
              </button>
            )}
            <button type="button" className="ghost" onClick={() => setShowError(false)}>
              Close
            </button>
          </div>
        </div>
      )}
      {voice.speechIssue && voice.state.kind !== 'error' && (
        <div className="ask-pop" role="status">
          <p>{voice.speechIssue}</p>
          <div className="ask-pop-actions">
            <button type="button" className="primary" onClick={p.onSettings}>
              Voice settings
            </button>
            <button type="button" className="ghost" onClick={voice.dismissSpeechIssue}>
              Close
            </button>
          </div>
        </div>
      )}
      {voice.heard && voice.state.kind !== 'error' && (
        <p className="ask-heard" aria-live="polite">
          “{voice.heard}”
        </p>
      )}
      {p.notice && !p.busy && !voice.heard && (
        <button type="button" className="ask-notice" onClick={p.onNotice}>
          {p.notice}
        </button>
      )}

      <form
        className={`askbar ${voice.speaking ? 'speaking' : voice.state.kind}${p.busy ? ' busy' : ''}`}
        onSubmit={(e) => {
          e.preventDefault()
          p.onSend(p.input)
        }}
      >
        {VOICE_ENABLED && (
          <button
            type="button"
            className="askbar-mic"
            onClick={() => {
              if (voice.speaking) voice.stopSpeaking()
              else {
                setShowError(true)
                voice.toggle()
              }
            }}
            title={
              voice.speaking
                ? 'Stop speaking'
                : listening
                  ? 'Stop listening'
                  : `Talk to Writey (or hold ${PTT_LABEL})`
            }
            aria-pressed={listening}
            aria-label={listening ? 'Stop listening' : 'Start listening'}
          >
            {listening || voice.speaking ? <MicIcon size={18} /> : <MicOffIcon size={18} />}
            <span className="askbar-wave" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </button>
        )}
        <textarea
          ref={p.inputRef}
          value={p.input}
          rows={1}
          placeholder={
            !p.canAsk
              ? 'Open a page to ask Writey'
              : listening
                ? 'Say “Hey, …” or type'
                : 'Ask Writey anything about this page…'
          }
          disabled={!p.canAsk}
          onChange={(e) => {
            p.onInput(e.target.value)
            e.target.style.height = '0px'
            e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              p.onSend(p.input)
            } else if (e.key === 'Escape') {
              if (p.input) p.onInput('')
              else if (p.conversationOpen) p.onConversation(false)
              e.currentTarget.blur()
            }
          }}
          aria-label="Ask Writey"
        />
        {VOICE_ENABLED && !p.input && !p.busy && (
          <button
            type="button"
            className="askbar-help"
            onClick={() => setGuide((g) => !g)}
            title="What can I say?"
            aria-expanded={guide}
          >
            ?
          </button>
        )}
        {p.hasConversation && !p.conversationOpen && (
          <button
            type="button"
            className="askbar-icon"
            onClick={() => p.onConversation(true)}
            title="Show the conversation"
            aria-label="Show the conversation"
          >
            <NewChatIcon size={17} />
          </button>
        )}
        {p.busy ? (
          <button
            type="button"
            className="askbar-send stop"
            onClick={p.onStop}
            title="Stop"
            aria-label="Stop"
          >
            <StopIcon size={16} />
          </button>
        ) : (
          <button
            type="submit"
            className="askbar-send"
            disabled={!p.input.trim() || !p.canAsk}
            title="Ask (Enter)"
            aria-label="Ask"
          >
            <SendIcon size={16} />
          </button>
        )}
      </form>
      <p className="askbar-status" aria-live="polite">
        {status ? (
          <>
            {p.busy && <span className="thinking-dot" aria-hidden="true" />}
            <span>{status}</span>
            {hint && <span className="faint"> · {hint}</span>}
          </>
        ) : (
          <span className="faint">
            {VOICE_ENABLED ? `${MOD} K to type · click the mic to talk` : `${MOD} K to type`}
            {p.chatgpt && (
              <>
                {' · '}Using ChatGPT plan ·{' '}
                <a href={CHATGPT_USAGE_URL} target="_blank" rel="noopener noreferrer">
                  Manage usage
                </a>
              </>
            )}
          </span>
        )}
      </p>
    </div>
  )
}
