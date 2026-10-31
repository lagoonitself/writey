import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { call } from './native'

// Local speech in the desktop app (apps/desktop/src/voice): the mic, Silero VAD, Parakeet
// and Kokoro all run in Rust, on the GPU when there is one. The page decides what a heard
// line means (voice/trigger.ts).

export type ModelState =
  | { state: 'missing' }
  | { state: 'downloading'; progress: number }
  | { state: 'downloaded' }
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'error'; error: string }

export type ModelStatus = ModelState & { bytes: number; device: 'gpu' | 'cpu' | null }

export type Accel = 'cuda' | 'coreml' | 'cpu'

export type VoiceStatus = {
  available: boolean
  accel: Accel
  gpu_name: string | null
  gpu_error: string | null
  prefer: 'auto' | 'cpu'
  /** Windows: the speech engine libraries, downloaded with the models. */
  engine: ModelStatus | null
  stt: ModelStatus
  tts: ModelStatus
  voices: { id: string; name: string }[]
  listening: boolean
}

export const voiceStatus = () => call<VoiceStatus>('voice_status')

/** Downloads (the first time) and loads the models in the background. */
export const voicePrepare = (which: { stt?: boolean; tts?: boolean }) =>
  call<VoiceStatus>('voice_prepare', { stt: Boolean(which.stt), tts: Boolean(which.tts) })

export const voiceStart = () => call<void>('voice_start')
export const voiceStop = () => call<void>('voice_stop')
export const voicePtt = (down: boolean) => call<void>('voice_ptt', { down })
export const voiceSay = (text: string, voice: string) => call<void>('voice_say', { text, voice })
export const voiceStopSpeaking = () => call<void>('voice_stop_speaking')
export const voiceSetPrefer = (prefer: 'auto' | 'cpu') =>
  call<VoiceStatus>('voice_set_prefer', { prefer })
export const voiceRemoveModels = () => call<VoiceStatus>('voice_remove_models')

export type VoiceEvents = {
  'voice:models': VoiceStatus
  'voice:state': { kind: 'listening' | 'transcribing' | 'error'; message?: string }
  'voice:speech-start': null
  'voice:segment': { text: string; ptt: boolean; during_speech: boolean }
  'voice:speaking': { on: boolean; finished: boolean }
  'voice:playback': { live: boolean }
  'voice:issue': string
}

export function onVoice<K extends keyof VoiceEvents>(
  name: K,
  handler: (payload: VoiceEvents[K]) => void,
): Promise<UnlistenFn> {
  return listen<VoiceEvents[K]>(name, (e) => handler(e.payload))
}

/** The download size of what's missing, for the "Download" button. */
export function missingBytes(s: VoiceStatus): number {
  const parts = [s.engine, s.stt, s.tts].filter((m): m is ModelStatus => m !== null)
  return parts
    .filter((m) => m.state === 'missing' || m.state === 'error')
    .reduce((n, m) => n + m.bytes, 0)
}

export const ready = (m: ModelStatus | null) => m === null || m.state === 'ready'

export function formatBytes(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`
}
