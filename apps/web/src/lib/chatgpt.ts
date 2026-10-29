import * as desktop from './desktop/chatgpt'
import { isDesktop, NativeError } from './native'
import * as web from './web/helper'

// Sign in with ChatGPT. The desktop app does it itself; the website needs Writey Helper on
// the computer (OpenAI only allows a 127.0.0.1 callback; HANDOFF D15, D26).

export type { ChatgptStatus } from './desktop/chatgpt'

const helperError = (e: unknown) =>
  e instanceof web.HelperError ? new NativeError(e.code, e.code) : e

export const chatgptStatus = () => (isDesktop() ? desktop.chatgptStatus() : web.chatgptStatus())

export const chatgptWelcomed = async (): Promise<void> => {
  if (isDesktop()) await desktop.chatgptWelcomed()
  else await web.chatgptWelcomed()
}

export const chatgptLogout = () => (isDesktop() ? desktop.chatgptLogout() : web.chatgptLogout())

/** Desktop only: opens the sign-in in the browser and resolves when it's done. */
export const chatgptLogin = desktop.chatgptLogin
export const chatgptCancelLogin = desktop.chatgptCancelLogin

/** Streams a Responses API call with the ChatGPT plan. The caller reads the response. */
export async function chatgptResponses(body: string, signal: AbortSignal): Promise<Response> {
  if (isDesktop()) return desktop.chatgptResponses(body, signal)
  try {
    return await web.chatgptResponses(body, signal)
  } catch (e) {
    throw helperError(e)
  }
}
