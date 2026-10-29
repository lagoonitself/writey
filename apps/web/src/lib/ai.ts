import type { ModelInfo, Turn } from '@writey/ai-core'
import type { AiProvider, AiSettings, CredentialInfo, KeyProvider } from '@writey/shared'
import * as desktop from './desktop/ai'
import { isDesktop, NativeError } from './native'
import * as web from './web/ai'
import { ApiRequestError } from './web/api'

// Provider keys, AI settings, model calls and conversations. The desktop app keeps keys in
// the OS keychain and calls models from Rust; the website does both through the Worker.
const impl = isDesktop() ? desktop : web

export type { StoredMessage, ThreadInfo } from './desktop/ai'

import type { StoredMessage } from './desktop/ai'

/** Website errors carry the Worker's error code; desktop ones already are NativeErrors. */
async function same<T>(p: Promise<T>): Promise<T> {
  try {
    return await p
  } catch (e) {
    if (e instanceof ApiRequestError) throw new NativeError(e.message, e.message)
    throw e
  }
}

export const listCredentials = (): Promise<CredentialInfo[]> => same(impl.listCredentials())
export const saveCredential = (p: KeyProvider, key: string): Promise<CredentialInfo> =>
  same(impl.saveCredential(p, key))
export const deleteCredential = (p: KeyProvider): Promise<void> => same(impl.deleteCredential(p))
export const loadAiSettings = (): Promise<AiSettings> => impl.loadAiSettings()
export const saveAiSettings = (ai: AiSettings): Promise<void> => impl.saveAiSettings(ai)
export const listModels = (p: AiProvider): Promise<ModelInfo[]> => impl.listModels(p)
export const chatRequest = (p: KeyProvider, body: string, signal: AbortSignal) =>
  impl.chatRequest(p, body, signal)

/** Forgets every saved key and the ChatGPT sign-in (desktop: when the keychain lost its key). */
export const resetVault = (): Promise<void> =>
  isDesktop() ? desktop.resetVault() : Promise.resolve()

/**
 * "Connect OpenRouter". The desktop app resolves with the saved key once approved in the
 * browser; the website leaves for openrouter.ai and comes back to OPENROUTER_CALLBACK.
 */
export async function connectOpenRouter(): Promise<CredentialInfo> {
  if (isDesktop()) return desktop.connectOpenRouter()
  await web.startOpenRouterConnect()
  return new Promise(() => {})
}

export const cancelOpenRouter = (): Promise<void> =>
  isDesktop() ? desktop.cancelOpenRouter() : Promise.resolve()

export const OPENROUTER_CALLBACK = web.OPENROUTER_CALLBACK
export const finishOpenRouterConnect = web.finishOpenRouterConnect

export const listThreads = (notebookId: string) => impl.listThreads(notebookId)
export const loadMessages = (threadId: string) => impl.loadMessages(threadId)
export const createThread = (notebookId: string, title: string) =>
  impl.createThread(notebookId, title)
export const appendMessages = (threadId: string, messages: Omit<StoredMessage, 'id'>[]) =>
  impl.appendMessages(threadId, messages)
export const deleteThread = (id: string) => impl.deleteThread(id)

/**
 * A reply as the model should remember it. The copy of the page is marked as handwriting, so
 * the model doesn't take it for chat text and start repeating its working in the chat.
 */
const plainReply = (text: string) =>
  text
    .replace(/<p class="said">([\s\S]*?)<\/p>/g, '(Said out loud: $1)')
    .replace(
      /<details[^>]*><summary>Written on ([^<·]*?)\s*·[^<]*<\/summary>([\s\S]*?)<\/details>/g,
      (_, where: string, lines: string) =>
        `[Handwritten on ${where.trim()}, shown on the page and not in the chat:\n${lines.trim()}]`,
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

/** Question-and-answer pairs for the model's history; failed or unanswered asks are left out. */
export function turnsOf(messages: readonly StoredMessage[]): Turn[] {
  const turns: Turn[] = []
  for (let i = 0; i < messages.length - 1; i++) {
    const q = messages[i] as StoredMessage
    const a = messages[i + 1] as StoredMessage
    if (q.role === 'user' && a.role === 'assistant' && !a.error && a.text) {
      turns.push({ role: 'user', text: q.text }, { role: 'assistant', text: plainReply(a.text) })
      i++
    }
  }
  return turns
}
