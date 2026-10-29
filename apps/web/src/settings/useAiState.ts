import { type AiProvider, type AiSettings, type CredentialInfo, DEFAULT_AI } from '@writey/shared'
import { useEffect, useState } from 'react'
import { listCredentials, loadAiSettings, saveAiSettings } from '../lib/ai'
import { type ChatgptStatus, chatgptStatus } from '../lib/chatgpt'
import { isDesktop } from '../lib/native'
import { chatgptUsed, type HelperState, helperState } from '../lib/web/helper'

export type AiState = {
  settings: AiSettings
  credentials: CredentialInfo[]
  /** How the ChatGPT sign-in stands; null until checked. */
  chatgpt: ChatgptStatus | null
  /** Website: how Writey Helper answered; null until checked (only after a ChatGPT sign-in). */
  helper?: HelperState | null
  /** Desktop: why saved keys couldn't be read (the keychain lost the vault key). */
  vaultError?: string
}

/** Whether asking with this provider can work right now. */
export function usable(ai: AiState, provider: AiProvider): boolean {
  if (provider === 'chatgpt') return Boolean(ai.chatgpt?.signed_in && ai.chatgpt.plan_usage)
  return ai.credentials.some((c) => c.provider === provider)
}

/** Set by the OpenRouter callback so the next screen opens Settings to show the result. */
export const OPEN_SETTINGS_FLAG = 'writey.openSettings'

/**
 * Website: how a ChatGPT sign-in went, when the Helper just sent this tab back to Writey.
 * Read once at load and taken out of the address bar.
 */
export const chatgptReturn: { ok: boolean; error: string | null } | null = (() => {
  if (isDesktop() || typeof location === 'undefined') return null
  const params = new URLSearchParams(location.search)
  const outcome = params.get('chatgpt')
  if (!outcome) return null
  const error = params.get('chatgpt_error')
  params.delete('chatgpt')
  params.delete('chatgpt_error')
  const query = params.toString()
  history.replaceState(history.state, '', location.pathname + (query ? `?${query}` : ''))
  return { ok: outcome === 'connected', error: outcome === 'connected' ? null : error }
})()

/** Website: asks the Helper how ChatGPT sign-in stands. */
export async function probeHelper(): Promise<Pick<AiState, 'helper' | 'chatgpt'>> {
  const helper = await helperState()
  if (helper !== 'ok') return { helper, chatgpt: null }
  const chatgpt = await chatgptStatus().catch(() => null)
  return { helper, chatgpt }
}

export function useAiState(): [AiState, (next: AiState) => void] {
  const [state, setState] = useState<AiState>({
    settings: DEFAULT_AI,
    credentials: [],
    chatgpt: null,
    helper: null,
  })
  useEffect(() => {
    let live = true
    if (isDesktop()) {
      Promise.allSettled([loadAiSettings(), listCredentials(), chatgptStatus()]).then(
        ([settings, credentials, chatgpt]) => {
          if (!live) return
          const failed = [credentials, chatgpt].find((r) => r.status === 'rejected')
          setState((s) => ({
            ...s,
            settings: settings.status === 'fulfilled' ? settings.value : s.settings,
            credentials: credentials.status === 'fulfilled' ? credentials.value : [],
            chatgpt: chatgpt.status === 'fulfilled' ? chatgpt.value : null,
            vaultError:
              failed?.status === 'rejected' ? (failed.reason as Error).message : undefined,
          }))
        },
      )
      return () => {
        live = false
      }
    }
    const loaded = Promise.all([loadAiSettings(), listCredentials()])
    loaded
      .then(([settings, credentials]) => live && setState((s) => ({ ...s, settings, credentials })))
      .catch((e) => console.error('AI settings failed to load', e))
    // Contacting 127.0.0.1 makes Chrome ask about local network access, so only browsers
    // that have used ChatGPT check the Helper on load.
    if (chatgptReturn || chatgptUsed()) {
      Promise.all([probeHelper(), loaded.catch(() => null)]).then(async ([h, base]) => {
        if (!live) return
        let settings = base?.[0]
        // Just signed in and nothing else is set up: switch to ChatGPT right away.
        const others = (base?.[1] ?? []).length > 0
        if (
          chatgptReturn?.ok &&
          h.chatgpt?.plan_usage &&
          settings?.provider !== 'chatgpt' &&
          !others
        ) {
          settings = { provider: 'chatgpt', model: '' }
          await saveAiSettings(settings).catch(() => {})
        }
        if (live) setState((s) => ({ ...s, ...h, ...(settings ? { settings } : {}) }))
      })
    }
    return () => {
      live = false
    }
  }, [])
  return [state, setState]
}

let returnUnseen = chatgptReturn !== null

/** Website: true once, right after returning from "Connect OpenRouter" or ChatGPT sign-in. */
export function takeOpenSettingsFlag(): boolean {
  if (isDesktop()) return false
  const set = sessionStorage.getItem(OPEN_SETTINGS_FLAG) === '1'
  const back = returnUnseen
  // Cleared a tick later so StrictMode's double initializer call sees it both times.
  setTimeout(() => {
    if (set) sessionStorage.removeItem(OPEN_SETTINGS_FLAG)
    returnUnseen = false
  }, 0)
  return set || back
}
