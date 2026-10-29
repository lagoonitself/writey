import { type ModelInfo, parseModels, type Usage } from '@writey/ai-core'
import {
  type AiProvider,
  type AiSettings,
  type CredentialInfo,
  DEFAULT_AI,
  isAiProvider,
  type KeyProvider,
} from '@writey/shared'
import { call, streamResponse } from '../native'

// ---------------------------------------------------------------------------
// Provider keys: kept encrypted on this computer, the key itself never reaches the page
// ---------------------------------------------------------------------------

export const listCredentials = () => call<CredentialInfo[]>('credentials_list')

export const saveCredential = (provider: KeyProvider, key: string) =>
  call<CredentialInfo>('credential_save', { provider, key })

export const deleteCredential = (provider: KeyProvider) =>
  call<void>('credential_delete', { provider })

/** Forgets every saved key and the ChatGPT sign-in (when the keychain lost the vault key). */
export const resetVault = () => call<void>('vault_reset')

// ---------------------------------------------------------------------------
// Provider and model choice
// ---------------------------------------------------------------------------

export async function loadAiSettings(): Promise<AiSettings> {
  const ai = await call<Partial<AiSettings> | null>('setting_get', { key: 'ai' })
  if (ai?.provider && isAiProvider(ai.provider) && typeof ai.model === 'string') {
    return { provider: ai.provider, model: ai.model }
  }
  return DEFAULT_AI
}

export const saveAiSettings = (ai: AiSettings) =>
  call<void>('setting_set', { key: 'ai', value: ai })

export function listModels(provider: AiProvider): Promise<ModelInfo[]> {
  // Rust caches the public lists for an hour; ChatGPT's depends on who is signed in.
  return call<unknown>('models_list', { provider }).then((json) => parseModels(provider, json))
}

/** Sends a Chat Completions body with the saved key. The caller reads the response. */
export const chatRequest = (provider: KeyProvider, body: string, signal: AbortSignal) =>
  streamResponse('ai_chat', { provider, body }, signal)

// ---------------------------------------------------------------------------
// "Connect OpenRouter": OAuth PKCE in the browser instead of pasting a key (docs §6.4)
// ---------------------------------------------------------------------------

/** Opens openrouter.ai in the browser and resolves with the saved key once approved. */
export const connectOpenRouter = () => call<CredentialInfo>('openrouter_connect')

export const cancelOpenRouter = () => call<void>('openrouter_cancel')

// ---------------------------------------------------------------------------
// Conversations: per notebook, several per notebook, newest first (docs §5.8)
// ---------------------------------------------------------------------------

export type StoredMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  mode?: string
  model?: string | null
  usage?: Usage | null
  error?: boolean
}

export type ThreadInfo = { id: string; title: string | null; updated_at: string }

export const listThreads = (notebookId: string) =>
  call<ThreadInfo[]>('threads_list', { notebookId })

export const loadMessages = (threadId: string) =>
  call<StoredMessage[]>('messages_load', { threadId })

export const createThread = (notebookId: string, title: string) =>
  call<ThreadInfo>('thread_create', { notebookId, title })

export const appendMessages = (threadId: string, messages: Omit<StoredMessage, 'id'>[]) =>
  call<void>('messages_append', {
    threadId,
    messages: messages.map((m) => ({
      ...m,
      id: '',
      model: m.model ?? null,
      usage: m.usage ?? null,
    })),
  })

export const deleteThread = (id: string) => call<void>('thread_delete', { id })
