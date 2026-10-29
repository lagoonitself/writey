import { call, streamResponse } from '../native'

// Sign in with ChatGPT, done by the desktop app itself (apps/desktop/src/ai/chatgpt.rs).
// The tokens stay in Rust; the page only learns the email and whether plan usage is on.

export type ChatgptStatus = {
  signed_in: boolean
  email: string | null
  /** The plan-usage scope was granted, so requests can use the ChatGPT plan. */
  plan_usage: boolean
  /** First sign-in: show the "You're using your ChatGPT plan" notice once. */
  welcome: boolean
  login_pending: boolean
  error: string | null
}

export const chatgptStatus = () => call<ChatgptStatus>('chatgpt_status')

/** Opens OpenAI's sign-in in the browser and resolves once it comes back (or is cancelled). */
export const chatgptLogin = (switchAccount = false) =>
  call<ChatgptStatus>('chatgpt_login', { switchAccount })

export const chatgptCancelLogin = () => call<void>('chatgpt_cancel_login')

export const chatgptWelcomed = () => call<void>('chatgpt_welcomed')

export const chatgptLogout = () => call<{ revoked: boolean | null }>('chatgpt_logout')

/** Streams a Responses API call with the ChatGPT plan. The caller reads the response. */
export const chatgptResponses = (body: string, signal: AbortSignal) =>
  streamResponse('ai_chatgpt', { body }, signal)
