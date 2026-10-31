import { addressed, type VoiceCommand, voiceCommand } from './trigger'

export type FlowState = {
  armedUntil: number
  followUntil: number
  answering: boolean
  playbackLive: boolean
  speaking: boolean
  pendingFollowUp: boolean
  lastSubmit: { text: string; at: number }
}

export const freshFlow = (): FlowState => ({
  armedUntil: 0,
  followUntil: 0,
  answering: false,
  playbackLive: false,
  speaking: false,
  pendingFollowUp: false,
  lastSubmit: { text: '', at: 0 },
})

export type SegmentAction =
  | { type: 'command'; cmd: VoiceCommand }
  | { type: 'request'; text: string }
  | { type: 'arm' }
  | { type: 'none' }

const norm = (s: string) => s.trim().toLowerCase()

export function blockedQuestion(state: FlowState): boolean {
  return state.answering || state.speaking || state.playbackLive
}

export function segmentAction(
  state: FlowState,
  text: string,
  ptt: boolean,
  overWritey: boolean,
  now: number,
): SegmentAction {
  if (!text.trim()) return { type: 'none' }
  const address = addressed(text)
  const replyWindow = now < state.followUntil
  const reply = ptt || overWritey || replyWindow

  if (overWritey) {
    const request = address?.request ?? text
    const cmd = voiceCommand(request) ?? voiceCommand(text)
    if (cmd) return { type: 'command', cmd }
    if (address || ptt) return asRequest(state, request, now, true)
    return { type: 'none' }
  }

  if (reply) {
    const request = address?.request ?? text
    return asRequest(state, request, now, replyWindow || ptt)
  }

  if (address) {
    if (!address.request) return { type: 'arm' }
    return asRequest(state, address.request, now, false)
  }

  if (now < state.armedUntil) return asRequest(state, text, now, false)

  return { type: 'none' }
}

function asRequest(
  state: FlowState,
  request: string,
  now: number,
  fromReply: boolean,
): SegmentAction {
  const trimmed = request.trim()
  if (!trimmed) return { type: 'none' }
  const cmd = voiceCommand(trimmed)
  if (cmd) return { type: 'command', cmd }
  if (blockedQuestion(state) && !fromReply) return { type: 'none' }
  const key = norm(trimmed)
  if (key === state.lastSubmit.text && now - state.lastSubmit.at < 3000) return { type: 'none' }
  return { type: 'request', text: trimmed }
}

export function applyArm(state: FlowState, now: number, armMs: number): FlowState {
  return { ...state, armedUntil: now + armMs }
}

export function applyRequest(state: FlowState, text: string, now: number): FlowState {
  return {
    ...state,
    armedUntil: 0,
    followUntil: 0,
    answering: true,
    lastSubmit: { text: norm(text), at: now },
  }
}

export function applyAnswered(state: FlowState): FlowState {
  return { ...state, answering: false, pendingFollowUp: true }
}

export function tryOpenFollowUp(state: FlowState, now: number, windowMs: number): FlowState | null {
  if (!state.pendingFollowUp) return null
  if (state.speaking || state.playbackLive) return null
  return {
    ...state,
    pendingFollowUp: false,
    followUntil: now + windowMs,
  }
}

export function closeFollowUp(state: FlowState): FlowState {
  return { ...state, followUntil: 0, pendingFollowUp: false }
}
