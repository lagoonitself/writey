import { type ModelInfo, parseModels, type Turn, type Usage } from '@writey/ai-core'
import {
  type AiProvider,
  type AiSettings,
  type CredentialInfo,
  DEFAULT_AI,
  isAiProvider,
  type KeyProvider,
} from '@writey/shared'
import { api, authedFetch, errorFrom } from './api'
import { chatgptModels } from './helper'
import { supabase } from './supabase'

// ---------------------------------------------------------------------------
// Provider keys, through the Worker (it encrypts them; docs §6.2)
// ---------------------------------------------------------------------------

export const listCredentials = () => api<CredentialInfo[]>('/credentials')

export const saveCredential = (provider: KeyProvider, key: string) =>
  api<CredentialInfo>(`/credentials/${provider}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })

export async function deleteCredential(provider: KeyProvider): Promise<void> {
  const res = await authedFetch(`/credentials/${provider}`, { method: 'DELETE' })
  if (!res.ok) throw await errorFrom(res)
}

// ---------------------------------------------------------------------------
// Provider and model choice, in profiles.settings.ai
// ---------------------------------------------------------------------------

export async function loadAiSettings(): Promise<AiSettings> {
  const { data } = await supabase.from('profiles').select('settings').maybeSingle()
  const ai = (data?.settings as { ai?: Partial<AiSettings> } | undefined)?.ai
  if (ai?.provider && isAiProvider(ai.provider) && typeof ai.model === 'string' && ai.model) {
    return { provider: ai.provider, model: ai.model }
  }
  return DEFAULT_AI
}

export async function saveAiSettings(ai: AiSettings): Promise<void> {
  const { data: user } = await supabase.auth.getUser()
  if (!user.user) throw new Error('Not signed in')
  const { data } = await supabase.from('profiles').select('settings').maybeSingle()
  const settings = { ...((data?.settings as object | undefined) ?? {}), ai }
  const { error } = await supabase.from('profiles').update({ settings }).eq('id', user.user.id)
  if (error) throw new Error(error.message)
}

const modelLists = new Map<KeyProvider, Promise<ModelInfo[]>>()

export function listModels(provider: AiProvider): Promise<ModelInfo[]> {
  // ChatGPT's list depends on who is signed in to the Helper, so it isn't cached.
  if (provider === 'chatgpt') return chatgptModels().then((json) => parseModels(provider, json))
  let p = modelLists.get(provider)
  if (!p) {
    p = api<unknown>(`/ai/${provider}/models`).then((json) => parseModels(provider, json))
    p.catch(() => modelLists.delete(provider))
    modelLists.set(provider, p)
  }
  return p
}

/** POSTs a Chat Completions body through the Worker. The caller reads the response. */
export const chatRequest = (provider: KeyProvider, body: string, signal: AbortSignal) =>
  authedFetch(`/ai/${provider}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal,
  })

// ---------------------------------------------------------------------------
// "Connect OpenRouter": OAuth PKCE instead of pasting a key (docs §6.4)
// ---------------------------------------------------------------------------

const VERIFIER_KEY = 'writey.openrouter.verifier'
const RETURN_KEY = 'writey.openrouter.return'
export const OPENROUTER_CALLBACK = '/connect/openrouter'

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

export async function startOpenRouterConnect(): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  )
  sessionStorage.setItem(VERIFIER_KEY, verifier)
  sessionStorage.setItem(RETURN_KEY, location.pathname)
  const url = new URL('https://openrouter.ai/auth')
  url.searchParams.set('callback_url', `${location.origin}${OPENROUTER_CALLBACK}`)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  location.assign(url)
}

/** Finishes the PKCE flow on the callback page. Returns the path to go back to. */
export async function finishOpenRouterConnect(code: string): Promise<string> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY)
  const back = sessionStorage.getItem(RETURN_KEY) ?? '/'
  sessionStorage.removeItem(VERIFIER_KEY)
  sessionStorage.removeItem(RETURN_KEY)
  if (!verifier) throw new Error('This sign-in link has expired. Try connecting again.')
  const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  })
  if (!res.ok) throw new Error(`OpenRouter refused the sign-in (${res.status}).`)
  const { key } = (await res.json()) as { key?: string }
  if (!key) throw new Error('OpenRouter did not return a key.')
  await saveCredential('openrouter', key)
  return back
}

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

type MessageRow = {
  id: string
  role: 'user' | 'assistant'
  content: { text?: string; mode?: string; error?: boolean }
  model: string | null
  usage: Usage | null
}

export async function listThreads(notebookId: string): Promise<ThreadInfo[]> {
  const { data, error } = await supabase
    .from('ai_threads')
    .select('id,title,updated_at')
    .eq('notebook_id', notebookId)
    .order('updated_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data as ThreadInfo[]
}

export async function loadMessages(threadId: string): Promise<StoredMessage[]> {
  const { data, error } = await supabase
    .from('ai_messages')
    .select('id,role,content,model,usage')
    .eq('thread_id', threadId)
    .order('created_at')
  if (error) throw new Error(error.message)
  return (data as MessageRow[]).map((m) => ({
    id: m.id,
    role: m.role,
    text: m.content.text ?? '',
    mode: m.content.mode,
    error: m.content.error,
    model: m.model,
    usage: m.usage,
  }))
}

export async function createThread(notebookId: string, title: string): Promise<ThreadInfo> {
  const { data, error } = await supabase
    .from('ai_threads')
    .insert({ notebook_id: notebookId, title: title.slice(0, 80) })
    .select('id,title,updated_at')
    .single()
  if (error) throw new Error(error.message)
  return data as ThreadInfo
}

export async function appendMessages(
  threadId: string,
  messages: Omit<StoredMessage, 'id'>[],
): Promise<void> {
  const { error } = await supabase.from('ai_messages').insert(
    messages.map((m) => ({
      thread_id: threadId,
      role: m.role,
      content: { text: m.text, mode: m.mode, error: m.error },
      model: m.model ?? null,
      usage: m.usage ?? null,
    })),
  )
  if (error) throw new Error(error.message)
}

export async function deleteThread(threadId: string): Promise<void> {
  const { error } = await supabase.from('ai_threads').delete().eq('id', threadId)
  if (error) throw new Error(error.message)
}

/** The model reads a reply as plain Markdown, without the chat's fold-out markup. */
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
