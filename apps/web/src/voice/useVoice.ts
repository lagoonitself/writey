import { useCallback, useEffect, useRef, useState } from 'react'
import { VoiceClient, type VoicePrefs, type VoiceState } from './client'
import type { VoiceCommand } from './trigger'

const PREFS_KEY = 'writey.voice'
/** Writey talks back by default (HANDOFF D9, changed 2026-10-25). */
const DEFAULT_PREFS: VoicePrefs = { replies: true, voice: 'af_heart' }
/** Hold this key (or a pen button mapped to it) to talk without saying "Hey". */
export const PTT_CODE = 'Backquote'
export const PTT_LABEL = '`'

export function loadVoicePrefs(): VoicePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<VoicePrefs>) } : DEFAULT_PREFS
  } catch {
    return DEFAULT_PREFS
  }
}

export function saveVoicePrefs(p: VoicePrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {}
  window.dispatchEvent(new Event('writey-voice-prefs'))
}

export type Voice = {
  state: VoiceState
  speaking: boolean
  /** The last thing heard, shown briefly. */
  heard: string | null
  /** Why Writey can't talk right now, e.g. its voice is still downloading. */
  speechIssue: string | null
  /** Writey just answered and is waiting for your reply (no "Hey" needed). */
  replying: boolean
  /** Writey talks back. */
  speaks(): boolean
  /** An answer finished. */
  answered(): void
  toggle(): void
  start(): void
  ask(text: string): void
  dismissSpeechIssue(): void
  say(text: string): void
  stopSpeaking(): void
  transcript(): string
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

export function useVoice(handlers: {
  request(text: string): void
  command(c: VoiceCommand): void
}): Voice {
  const [state, setState] = useState<VoiceState>({ kind: 'off' })
  const [speaking, setSpeaking] = useState(false)
  const [heard, setHeard] = useState<string | null>(null)
  const [speechIssue, setSpeechIssue] = useState<string | null>(null)
  const [replying, setReplying] = useState(false)
  const latest = useRef(handlers)
  latest.current = handlers
  const prefs = useRef(loadVoicePrefs())
  const heardTimer = useRef(0)

  useEffect(() => {
    const reload = () => {
      prefs.current = loadVoicePrefs()
    }
    window.addEventListener('writey-voice-prefs', reload)
    return () => window.removeEventListener('writey-voice-prefs', reload)
  }, [])

  const client = useRef<VoiceClient | null>(null)
  if (!client.current) {
    client.current = new VoiceClient(
      {
        state: setState,
        speaking: setSpeaking,
        heard(text) {
          setHeard(text)
          window.clearTimeout(heardTimer.current)
          heardTimer.current = window.setTimeout(() => setHeard(null), 4000)
        },
        request: (text) => latest.current.request(text),
        command: (c) => latest.current.command(c),
        speechIssue: setSpeechIssue,
        followUp: setReplying,
      },
      () => prefs.current,
    )
  }
  const c = client.current

  useEffect(() => () => c.stop(), [c])

  // Push-to-talk: hold the key while you speak.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== PTT_CODE || e.repeat || isTyping(e.target) || e.ctrlKey || e.metaKey) return
      e.preventDefault()
      void c.pttDown()
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== PTT_CODE) return
      c.pttUp()
    }
    const blur = () => c.pttUp()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [c])

  return {
    state,
    speaking,
    heard,
    speechIssue,
    replying,
    speaks: useCallback(() => c.speaks, [c]),
    answered: useCallback(() => c.answered(), [c]),
    toggle: useCallback(() => {
      if (c.on) c.stop()
      else void c.start()
    }, [c]),
    start: useCallback(() => void c.start(), [c]),
    ask: useCallback((text: string) => latest.current.request(text), []),
    dismissSpeechIssue: useCallback(() => setSpeechIssue(null), []),
    say: useCallback((text: string) => c.say(text), [c]),
    stopSpeaking: useCallback(() => c.stopSpeaking(), [c]),
    transcript: useCallback(() => c.transcript(), [c]),
  }
}
