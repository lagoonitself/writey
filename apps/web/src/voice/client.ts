import type { MicVAD } from '@ricky0123/vad-web'
import {
  HelperError,
  synthesize,
  transcribe,
  type VoiceStatus,
  voiceHelperState,
  voicePrepare,
  voiceStatus,
} from '../lib/helper'
import { sentences } from './speech'
import { type Address, addressed, type VoiceCommand, voiceCommand } from './trigger'

// The browser half of voice (docs §7.1–7.2): the mic, Silero VAD, push-to-talk, the 30 s
// transcript, the "Writey …" check and playback. The Helper only runs the models.

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
  /** It sounded like "Writey" but not clearly: ask before acting. */
  confirm(text: string): void
  command(c: VoiceCommand): void
  /** Writey just answered: the next sentence is a reply, no "Writey" needed. */
  followUp(open: boolean): void
}

const TRANSCRIPT_MS = 30_000
/** Mic closes itself after this long with no speech (docs §7.3). */
const SILENCE_PAUSE_MS = 10 * 60_000
/** After a bare "Writey", the next sentence within this window is the request. */
const ARMED_MS = 8_000
/** After Writey answers, how long it waits for a reply that doesn't start with "Writey". */
const FOLLOW_UP_MS = 10_000
const SAMPLE_RATE = 16_000

type Line = { who: 'you' | 'writey'; text: string; at: number }

export class VoiceClient {
  private vad: MicVAD | null = null
  private lines: Line[] = []
  private armedUntil = 0
  private ptt: Float32Array[] | null = null
  private skipSegment = false
  private speechActive = false
  private silenceTimer = 0
  private stopped = true
  /** Speech that began while Writey was talking: an interruption meant for it. */
  private bargedIn = false
  private followUntil = 0
  private followTimer = 0
  private followAfterSpeech = false
  private readonly speaker: Speaker

  constructor(
    private readonly ev: VoiceEvents,
    private readonly prefs: () => VoicePrefs,
  ) {
    this.speaker = new Speaker(
      () => this.prefs().voice,
      (on) => this.ev.speaking(on),
      () => {
        if (!this.followAfterSpeech) return
        this.followAfterSpeech = false
        this.followUp()
      },
    )
  }

  /** An answer finished: listen for a reply once Writey stops talking. */
  answered(): void {
    if (this.speaker.busy) this.followAfterSpeech = true
    else this.followUp()
  }

  get on(): boolean {
    return !this.stopped
  }

  /** Writey is listening and will talk back. */
  get speaks(): boolean {
    return this.on && this.prefs().replies
  }

  /** Opens the reply window: the next sentence goes to Writey without its name. */
  private followUp(): void {
    if (!this.on || this.speaker.busy) return
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
      const helper = await voiceHelperState()
      if (helper !== 'ok') {
        this.fail(
          helper === 'offline'
            ? 'Voice needs Writey Helper running on this computer.'
            : 'Update Writey Helper to talk to Writey.',
          helper === 'offline' ? 'setup' : 'update',
        )
        return
      }
      if (!(await this.modelsReady())) return
      await this.openMic()
      if (this.stopped) {
        await this.vad?.destroy()
        this.vad = null
        return
      }
      this.ev.state({ kind: 'listening' })
      this.resetSilence()
    } catch (e) {
      const err = e as Error
      const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError'
      this.fail(
        denied
          ? 'Chrome blocked the microphone. Allow it for this site, then try again.'
          : `Voice couldn't start: ${err.message}`,
        'retry',
      )
    }
  }

  /** Waits for speech-to-text to be ready, downloading it the first time. */
  private async modelsReady(): Promise<boolean> {
    let status: VoiceStatus = await voiceStatus()
    const want = { stt: true, tts: this.prefs().replies }
    if (status.stt.state !== 'ready' || (want.tts && status.tts.state !== 'ready')) {
      status = await voicePrepare(want)
    }
    while (!this.stopped && status.stt.state !== 'ready') {
      if (status.stt.state === 'error') {
        this.fail(`The speech model didn't load: ${status.stt.error ?? 'unknown error'}`, 'retry')
        return false
      }
      this.ev.state({
        kind: 'models',
        progress: status.stt.state === 'downloading' ? (status.stt.progress ?? 0) : null,
      })
      await new Promise((r) => setTimeout(r, 1000))
      status = await voiceStatus()
    }
    return !this.stopped
  }

  private async openMic(): Promise<void> {
    const { MicVAD } = await import('@ricky0123/vad-web')
    this.vad = await MicVAD.new({
      model: 'v5',
      // Threads need cross-origin isolation, which the site doesn't have; one is plenty.
      ortConfig: (ort) => {
        ort.env.wasm.numThreads = 1
      },
      baseAssetPath: '/vad/',
      onnxWASMBasePath: '/vad/',
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      redemptionMs: 650,
      preSpeechPadMs: 300,
      minSpeechMs: 250,
      startOnLoad: true,
      getStream: () =>
        navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            // Chrome's echo canceller keeps Writey from hearing itself (docs §7.1).
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }),
      onSpeechStart: () => {
        this.speechActive = true
        if (this.ptt) this.skipSegment = true
        // Barge-in: talking over Writey stops it, and what you say is for Writey.
        if (this.speaker.busy) this.bargedIn = true
        this.speaker.stop()
        // Still inside the reply window: hold it open while you finish the sentence.
        if (this.followUntil) {
          this.followUntil = Math.max(this.followUntil, Date.now() + FOLLOW_UP_MS)
          window.clearTimeout(this.followTimer)
        }
        this.resetSilence()
        if (!this.ptt) this.ev.state({ kind: 'hearing' })
      },
      onVADMisfire: () => {
        this.speechActive = false
        this.bargedIn = false
        if (this.followUntil) this.followUp()
        if (!this.ptt) this.ev.state({ kind: 'listening' })
      },
      onSpeechEnd: (audio) => {
        this.speechActive = false
        if (this.ptt || this.skipSegment) {
          this.skipSegment = false
          return
        }
        void this.segment(audio, false)
      },
      onFrameProcessed: (_, frame) => {
        this.ptt?.push(frame.slice())
      },
    })
  }

  stop(): void {
    this.stopped = true
    window.clearTimeout(this.silenceTimer)
    this.followAfterSpeech = false
    this.closeFollowUp()
    this.ptt = null
    this.speaker.stop()
    void this.vad?.destroy()
    this.vad = null
    this.ev.state({ kind: 'off' })
  }

  /** Push-to-talk held: everything said is a request, no "Writey" needed. */
  async pttDown(): Promise<void> {
    if (this.ptt) return
    this.speaker.stop()
    this.ptt = []
    this.skipSegment = this.speechActive
    this.ev.state({ kind: 'hearing' })
    if (this.stopped) await this.start()
  }

  pttUp(): void {
    const frames = this.ptt
    this.ptt = null
    if (!frames) return
    const length = frames.reduce((n, f) => n + f.length, 0)
    if (length < SAMPLE_RATE * 0.3) {
      if (this.on) this.ev.state({ kind: 'listening' })
      return
    }
    const audio = new Float32Array(length)
    let at = 0
    for (const f of frames) {
      audio.set(f, at)
      at += f.length
    }
    void this.segment(audio, true)
  }

  private async segment(audio: Float32Array, ptt: boolean): Promise<void> {
    // Decided when the sentence ends, not after transcribing: a reply that took a moment counts.
    const reply = this.bargedIn || Date.now() < this.followUntil
    this.bargedIn = false
    this.ev.state({ kind: 'transcribing' })
    let text: string
    try {
      text = await transcribe(audio)
    } catch (e) {
      if (e instanceof HelperError && e.code === 'not_ready') {
        this.stopped = true
        void this.vad?.destroy()
        this.vad = null
        await this.start()
      } else if (e instanceof HelperError && e.code === 'helper_offline') {
        this.fail('Writey Helper stopped. Start it again to keep talking.', 'retry')
      } else {
        console.error('transcribe failed', e)
        this.ev.state({ kind: 'listening' })
      }
      return
    }
    if (this.on) this.ev.state({ kind: 'listening' })
    if (!text) return
    this.remember('you', text)
    const address = addressed(text)
    this.ev.heard(text, address)

    let request: string | null = null
    if (ptt || reply) {
      request = address?.request || text
      this.closeFollowUp()
    } else if (address?.kind === 'strong') {
      if (!address.request) {
        this.armedUntil = Date.now() + ARMED_MS
        return
      }
      request = address.request
    } else if (address?.kind === 'weak') {
      this.ev.confirm(address.request || text)
      return
    } else if (Date.now() < this.armedUntil) request = text
    if (!request) return
    this.armedUntil = 0
    const cmd = voiceCommand(request)
    if (cmd) {
      if (cmd === 'stop') this.speaker.stop()
      this.ev.command(cmd)
    } else this.ev.request(request)
  }

  /** Says something (when spoken replies are on). Its text joins the transcript, not the mic. */
  say(text: string): void {
    if (!this.prefs().replies || !text.trim()) return
    this.remember('writey', text)
    this.speaker.say(text)
  }

  stopSpeaking(): void {
    this.speaker.stop()
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
    void this.vad?.destroy()
    this.vad = null
    this.ev.state({ kind: 'error', message, fix })
  }
}

/** Plays replies sentence by sentence, fetching the next while the current one plays. */
class Speaker {
  private queue: Promise<ArrayBuffer | null>[] = []
  private audio: HTMLAudioElement | null = null
  private abort: AbortController | null = null
  private playing = false
  /** Bumped by stop(), so a play loop that was waiting knows it's stale. */
  private gen = 0

  constructor(
    private readonly voice: () => string,
    private readonly onSpeaking: (on: boolean) => void,
    /** Finished saying everything (not stopped). */
    private readonly onDone: () => void,
  ) {}

  get busy(): boolean {
    return this.playing
  }

  say(text: string): void {
    if (!this.abort) this.abort = new AbortController()
    const signal = this.abort.signal
    for (const s of sentences(text)) {
      this.queue.push(synthesize(s, this.voice(), signal).catch(() => null))
    }
    if (!this.playing) void this.play()
  }

  private async play(): Promise<void> {
    const gen = this.gen
    this.playing = true
    this.onSpeaking(true)
    while (this.queue.length) {
      const next = this.queue.shift() as Promise<ArrayBuffer | null>
      const wav = await next
      if (gen !== this.gen) return
      if (!wav) continue
      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
      try {
        await new Promise<void>((resolve) => {
          const audio = new Audio(url)
          this.audio = audio
          audio.onended = () => resolve()
          audio.onerror = () => resolve()
          audio.onpause = () => resolve()
          audio.play().catch(() => resolve())
        })
      } finally {
        URL.revokeObjectURL(url)
        this.audio = null
      }
      if (gen !== this.gen) return
    }
    this.playing = false
    this.abort = null
    this.onSpeaking(false)
    this.onDone()
  }

  stop(): void {
    const was = this.playing
    this.gen++
    this.abort?.abort()
    this.abort = null
    this.queue = []
    this.playing = false
    this.audio?.pause()
    this.audio = null
    if (was) this.onSpeaking(false)
  }
}
