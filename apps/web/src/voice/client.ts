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
import {
  applyAnswered,
  applyArm,
  applyRequest,
  closeFollowUp,
  type FlowState,
  freshFlow,
  segmentAction,
  tryOpenFollowUp,
} from './flow'
import { sentences } from './speech'
import { type Address, addressed, type VoiceCommand } from './trigger'

export type VoiceState =
  | { kind: 'off' }
  | { kind: 'starting' }
  | { kind: 'models'; progress: number | null }
  | { kind: 'listening' }
  | { kind: 'hearing' }
  | { kind: 'transcribing' }
  | { kind: 'thinking' }
  | { kind: 'paused' }
  | { kind: 'error'; message: string; fix?: 'setup' | 'update' | 'retry' }

export type VoicePrefs = { replies: boolean; voice: string }

export type VoiceEvents = {
  state(s: VoiceState): void
  speaking(on: boolean): void
  heard(text: string, address: Address): void
  request(text: string): void
  command(c: VoiceCommand): void
  speechIssue(message: string | null): void
  followUp(open: boolean): void
}

const TRANSCRIPT_MS = 30_000
const SILENCE_PAUSE_MS = 10 * 60_000
const ARMED_MS = 8_000
const FOLLOW_UP_MS = 10_000

type Line = { who: 'you' | 'writey'; text: string; at: number }

const modelsBusy = (s: VoiceStatus) =>
  [s.engine, s.stt].some((m) => m && (m.state === 'downloading' || m.state === 'loading'))

export class VoiceClient {
  private lines: Line[] = []
  private flow: FlowState = freshFlow()
  private ptt = false
  private silenceTimer = 0
  private stopped = true
  private followTimer = 0
  private status: VoiceStatus | null = null
  private unlisten: Promise<UnlistenFn[]> | null = null
  private rustKind: VoiceState['kind'] = 'off'

  constructor(
    private readonly ev: VoiceEvents,
    private readonly prefs: () => VoicePrefs,
  ) {}

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
        if (this.flow.followUntil) {
          this.flow.followUntil = Math.max(this.flow.followUntil, Date.now() + FOLLOW_UP_MS)
          window.clearTimeout(this.followTimer)
        }
        this.ev.state({ kind: 'hearing' })
      }),
      onVoice('voice:state', (s) => {
        if (this.stopped) return
        if (s.kind === 'error') this.fail(s.message ?? 'The microphone stopped.', 'retry')
        else if (!this.ptt) this.setRustState(s.kind)
      }),
      onVoice('voice:segment', (s) => this.line(s.text, s.ptt, s.during_speech)),
      onVoice('voice:speaking', ({ on, finished }) => {
        this.flow.speaking = on
        this.ev.speaking(on)
        if (on) {
          this.flow = closeFollowUp(this.flow)
          this.ev.followUp(false)
        } else if (finished) this.maybeFollowUp()
        this.syncUiState()
      }),
      onVoice('voice:playback', ({ live }) => {
        this.flow.playbackLive = live
        if (live) {
          this.flow = closeFollowUp(this.flow)
          this.ev.followUp(false)
        } else {
          this.maybeFollowUp()
        }
        this.syncUiState()
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

  answered(): void {
    this.flow = applyAnswered(this.flow)
    this.maybeFollowUp()
    this.syncUiState()
  }

  get on(): boolean {
    return !this.stopped
  }

  get speaks(): boolean {
    const tts = this.status?.tts.state
    return this.prefs().replies && (this.on || (tts !== undefined && tts !== 'missing'))
  }

  private maybeFollowUp(): void {
    const opened = tryOpenFollowUp(this.flow, Date.now(), FOLLOW_UP_MS)
    if (!opened) return
    this.flow = opened
    this.ev.followUp(true)
    window.clearTimeout(this.followTimer)
    this.followTimer = window.setTimeout(() => this.endFollowUp(), FOLLOW_UP_MS)
  }

  private endFollowUp(): void {
    window.clearTimeout(this.followTimer)
    this.flow = closeFollowUp(this.flow)
    this.ev.followUp(false)
    this.syncUiState()
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    this.flow = freshFlow()
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
      this.setRustState('listening')
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
    this.flow = freshFlow()
    this.endFollowUp()
    if (this.ptt) void voicePtt(false)
    this.ptt = false
    this.stopSpeaking()
    void voiceStop().catch(() => {})
    this.ev.state({ kind: 'off' })
  }

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
    if (overWritey) this.stopSpeaking()
    this.remember('you', text)
    const address = addressed(text)
    this.ev.heard(text, address)

    const now = Date.now()
    const action = segmentAction(this.flow, text, ptt, overWritey, now)
    if (action.type === 'arm') {
      this.flow = applyArm(this.flow, now, ARMED_MS)
      return
    }
    if (action.type === 'none') return

    this.flow = closeFollowUp(this.flow)
    this.ev.followUp(false)
    window.clearTimeout(this.followTimer)

    if (action.type === 'command') {
      if (action.cmd === 'stop') this.stopSpeaking()
      this.ev.command(action.cmd)
      return
    }

    this.flow = applyRequest(this.flow, action.text, now)
    this.syncUiState()
    this.ev.request(action.text)
  }

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
    if (this.flow.speaking) this.flow = applyAnswered(this.flow)
    void voiceStopSpeaking().catch(() => {})
  }

  transcript(): string {
    const since = Date.now() - TRANSCRIPT_MS
    this.lines = this.lines.filter((l) => l.at >= since)
    return this.lines.map((l) => `${l.who === 'you' ? 'Student' : 'Writey'}: ${l.text}`).join('\n')
  }

  private remember(who: Line['who'], text: string): void {
    this.lines.push({ who, text, at: Date.now() })
  }

  private setRustState(kind: 'listening' | 'transcribing'): void {
    this.rustKind = kind
    this.syncUiState()
  }

  private syncUiState(): void {
    if (this.stopped) return
    if (this.flow.answering && !this.flow.speaking && !this.flow.playbackLive) {
      this.ev.state({ kind: 'thinking' })
      return
    }
    if (this.flow.followUntil > Date.now()) {
      this.ev.state({ kind: 'listening' })
      return
    }
    if (this.rustKind === 'transcribing') this.ev.state({ kind: 'transcribing' })
    else this.ev.state({ kind: 'listening' })
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
