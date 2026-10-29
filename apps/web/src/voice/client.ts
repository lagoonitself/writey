import type { UnlistenFn } from '@tauri-apps/api/event'
import { NativeError } from '../lib/native'
import {
  onVoice,
  type VoiceStatus,
  voicePrepare,
  voicePtt,
  voiceSay,
  voiceStart,
  voiceStatus,
  voiceStop,
  voiceStopSpeaking,
} from '../lib/voice'
import { sentences } from './speech'
import { type Address, addressed, type VoiceCommand, voiceCommand } from './trigger'

// The page's half of voice (docs §7): the 30 s transcript, the "Hey …" check, the reply
// window and commands. The desktop app's Rust side owns the mic, the voice detector, speech
// to text and the speaker, and sends each heard line here as an event.

export type VoiceState =
  | { kind: 'off' }
  | { kind: 'starting' }
  | { kind: 'models'; progress: number | null }
  | { kind: 'listening' }
  | { kind: 'hearing' }
  | { kind: 'transcribing' }
  | { kind: 'paused' }
  | { kind: 'error'; message: string; fix?: 'setup' | 'update' | 'retry' }

export type VoicePrefs = { replies: boolean; voice: string }

export type VoiceEvents = {
  state(s: VoiceState): void
  speaking(on: boolean): void
  /** Every line heard, for the "Heard: …" hint. */
  heard(text: string, address: Address): void
  /** Writey was addressed (or push-to-talk): ask this. */
  request(text: string): void
  command(c: VoiceCommand): void
  /** Why Writey can't talk right now (null once it can). */
  speechIssue(message: string | null): void
  /** Writey just answered: the next sentence is a reply, no "Hey" needed. */
  followUp(open: boolean): void
}

const TRANSCRIPT_MS = 30_000
/** The mic closes itself after this long with no speech (docs §7.3). */
const SILENCE_PAUSE_MS = 10 * 60_000
/** After a bare "Hey", the next sentence within this window is the request. */
const ARMED_MS = 8_000
/** After Writey answers, how long it waits for a reply that doesn't start with "Hey". */
const FOLLOW_UP_MS = 10_000

type Line = { who: 'you' | 'writey'; text: string; at: number }

const modelsBusy = (s: VoiceStatus) =>
  [s.engine, s.stt].some((m) => m && (m.state === 'downloading' || m.state === 'loading'))

export class VoiceClient {
  private lines: Line[] = []
  private armedUntil = 0
  private ptt = false
  private silenceTimer = 0
  private stopped = true
  private followUntil = 0
  private followTimer = 0
  private followAfterSpeech = false
  private speakingNow = false
  private status: VoiceStatus | null = null
  private unlisten: Promise<UnlistenFn[]> | null = null

  constructor(
    private readonly ev: VoiceEvents,
    private readonly prefs: () => VoicePrefs,
  ) {}

  /** Starts listening to the app's voice events (undone by `dispose`). */
  attach(): void {
    if (this.unlisten) return
    void voiceStatus()
      .then((s) => {
        this.status = s
      })
      .catch(() => {})
    this.unlisten = Promise.all([
      onVoice('voice:models', (s) => {
        this.status = s
      }),
      onVoice('voice:speech-start', () => {
        if (this.stopped || this.ptt) return
        this.resetSilence()
        // Still inside the reply window: hold it open while you finish the sentence.
        if (this.followUntil) {
          this.followUntil = Math.max(this.followUntil, Date.now() + FOLLOW_UP_MS)
          window.clearTimeout(this.followTimer)
        }
        this.ev.state({ kind: 'hearing' })
      }),
      onVoice('voice:state', (s) => {
        if (this.stopped) return
        if (s.kind === 'error') this.fail(s.message ?? 'The microphone stopped.', 'retry')
        else if (!this.ptt) this.ev.state({ kind: s.kind })
      }),
      onVoice('voice:segment', (s) => this.line(s.text, s.ptt, s.during_speech)),
      onVoice('voice:speaking', ({ on, finished }) => {
        this.speakingNow = on
        this.ev.speaking(on)
        if (!on && finished && this.followAfterSpeech) {
          this.followAfterSpeech = false
          this.followUp()
        }
        if (!on && !finished) this.followAfterSpeech = false
      }),
      onVoice('voice:issue', (message) => this.ev.speechIssue(message)),
    ])
  }

  dispose(): void {
    this.stop()
    void this.unlisten?.then((fns) => {
      for (const f of fns) f()
    })
    this.unlisten = null
  }

  /** An answer finished: listen for a reply once Writey stops talking. */
  answered(): void {
    if (this.speakingNow) this.followAfterSpeech = true
    else this.followUp()
  }

  get on(): boolean {
    return !this.stopped
  }

  /** Writey talks back (typed questions too) once its voice has been downloaded. */
  get speaks(): boolean {
    const tts = this.status?.tts.state
    return this.prefs().replies && (this.on || (tts !== undefined && tts !== 'missing'))
  }

  /** Opens the reply window: the next sentence goes to Writey without "Hey". */
  private followUp(): void {
    if (!this.on || this.speakingNow) return
    this.followUntil = Date.now() + FOLLOW_UP_MS
    this.ev.followUp(true)
    window.clearTimeout(this.followTimer)
    this.followTimer = window.setTimeout(() => this.closeFollowUp(), FOLLOW_UP_MS)
  }

  private closeFollowUp(): void {
    window.clearTimeout(this.followTimer)
    if (!this.followUntil) return
    this.followUntil = 0
    this.ev.followUp(false)
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    this.ev.state({ kind: 'starting' })
    try {
      let status = await voiceStatus()
      if (!status.available) {
        this.fail('Voice isn’t part of this build of Writey.')
        return
      }
      if (status.stt.state !== 'ready') {
        status = await voicePrepare({ stt: true, tts: this.prefs().replies })
      }
      while (!this.stopped && status.stt.state !== 'ready') {
        const failed = [status.engine, status.stt].find((m) => m?.state === 'error')
        if (failed?.state === 'error') {
          this.fail(`The speech model didn’t load: ${failed.error}`, 'retry')
          return
        }
        if (!modelsBusy(status) && status.stt.state !== 'downloaded') {
          status = await voicePrepare({ stt: true, tts: this.prefs().replies })
        }
        const dl = [status.engine, status.stt].find((m) => m?.state === 'downloading')
        this.ev.state({
          kind: 'models',
          progress: dl?.state === 'downloading' ? dl.progress : null,
        })
        await new Promise((r) => setTimeout(r, 700))
        status = await voiceStatus()
      }
      if (this.stopped) return
      await voiceStart()
      if (this.stopped) {
        void voiceStop()
        return
      }
      this.ev.state({ kind: 'listening' })
      this.resetSilence()
    } catch (e) {
      const err = e as Error
      this.fail(
        err instanceof NativeError && err.code === 'mic'
          ? err.message
          : `Voice couldn’t start: ${err.message}`,
        'retry',
      )
    }
  }

  stop(): void {
    this.stopped = true
    window.clearTimeout(this.silenceTimer)
    this.followAfterSpeech = false
    this.closeFollowUp()
    if (this.ptt) void voicePtt(false)
    this.ptt = false
    this.stopSpeaking()
    void voiceStop().catch(() => {})
    this.ev.state({ kind: 'off' })
  }

  /** Push-to-talk held: everything said is a request, no "Hey" needed. */
  async pttDown(): Promise<void> {
    if (this.ptt) return
    this.stopSpeaking()
    this.ptt = true
    if (this.stopped) await this.start()
    if (this.stopped || !this.ptt) return
    this.ev.state({ kind: 'hearing' })
    await voicePtt(true).catch(() => {})
  }

  pttUp(): void {
    if (!this.ptt) return
    this.ptt = false
    void voicePtt(false).catch(() => {})
  }

  private line(text: string, ptt: boolean, overWritey: boolean): void {
    if (this.stopped || !text) return
    // Decided when the sentence ends: talking over Writey or inside the reply window.
    const reply = overWritey || Date.now() < this.followUntil
    if (overWritey) this.stopSpeaking()
    this.remember('you', text)
    const address = addressed(text)
    this.ev.heard(text, address)

    let request: string | null = null
    if (ptt || reply) {
      request = address?.request || text
      this.closeFollowUp()
    } else if (address) {
      if (!address.request) {
        this.armedUntil = Date.now() + ARMED_MS
        return
      }
      request = address.request
    } else if (Date.now() < this.armedUntil) request = text
    if (!request) return
    this.armedUntil = 0
    const cmd = voiceCommand(request)
    if (cmd) {
      if (cmd === 'stop') this.stopSpeaking()
      this.ev.command(cmd)
    } else this.ev.request(request)
  }

  /** Says something (when spoken replies are on). Its text joins the transcript, not the mic. */
  say(text: string): void {
    if (!this.speaks || !text.trim()) return
    this.remember('writey', text)
    const voice = this.prefs().voice
    if (this.status && this.status.tts.state !== 'ready') {
      void voicePrepare({ tts: true }).catch(() => {})
    }
    for (const s of sentences(text)) void voiceSay(s, voice).catch(() => {})
  }

  stopSpeaking(): void {
    if (this.speakingNow) this.followAfterSpeech = false
    void voiceStopSpeaking().catch(() => {})
  }

  /** The last 30 seconds of conversation, oldest first. */
  transcript(): string {
    const since = Date.now() - TRANSCRIPT_MS
    this.lines = this.lines.filter((l) => l.at >= since)
    return this.lines.map((l) => `${l.who === 'you' ? 'Student' : 'Writey'}: ${l.text}`).join('\n')
  }

  private remember(who: Line['who'], text: string): void {
    this.lines.push({ who, text, at: Date.now() })
  }

  private resetSilence(): void {
    window.clearTimeout(this.silenceTimer)
    this.silenceTimer = window.setTimeout(() => {
      if (this.stopped) return
      this.stop()
      this.ev.state({ kind: 'paused' })
    }, SILENCE_PAUSE_MS)
  }

  private fail(message: string, fix?: 'setup' | 'update' | 'retry'): void {
    this.stopped = true
    void voiceStop().catch(() => {})
    this.ev.state({ kind: 'error', message, fix })
  }
}
