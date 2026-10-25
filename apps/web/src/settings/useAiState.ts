import { type AiProvider, type AiSettings, type CredentialInfo, DEFAULT_AI } from '@writey/shared'
import { useEffect, useState } from 'react'
import { listCredentials, loadAiSettings } from '../lib/ai'
import {
  type ChatgptStatus,
  chatgptStatus,
  type HelperState,
  hasPairing,
  helperHealth,
} from '../lib/helper'

export type AiState = {
  settings: AiSettings
  credentials: CredentialInfo[]
  /** null until the Helper has been checked (only once this browser has paired). */
  helper: HelperState | null
  chatgpt: ChatgptStatus | null
}

/** Whether asking with this provider can work right now. */
export function usable(ai: AiState, provider: AiProvider): boolean {
  if (provider === 'chatgpt') return Boolean(ai.chatgpt?.signed_in && ai.chatgpt.plan_usage)
  return ai.credentials.some((c) => c.provider === provider)
}

/** Set by the OpenRouter callback so the next screen opens Settings to show the result. */
export const OPEN_SETTINGS_FLAG = 'writey.openSettings'

/** Asks a paired Helper how ChatGPT sign-in stands. */
export async function probeHelper(): Promise<Pick<AiState, 'helper' | 'chatgpt'>> {
  const helper = await helperHealth()
  if (!helper.paired) return { helper, chatgpt: null }
  const chatgpt = await chatgptStatus().catch(() => null)
  return { helper, chatgpt }
}

export function useAiState(): [AiState, (next: AiState) => void] {
  const [state, setState] = useState<AiState>({
    settings: DEFAULT_AI,
    credentials: [],
    helper: null,
    chatgpt: null,
  })
  useEffect(() => {
    let live = true
    Promise.all([loadAiSettings(), listCredentials()])
      .then(([settings, credentials]) => live && setState((s) => ({ ...s, settings, credentials })))
      .catch((e) => console.error('AI settings failed to load', e))
    // Contacting 127.0.0.1 makes Chrome ask about local network access, so only
    // browsers that already paired check the Helper on load.
    if (hasPairing()) {
      probeHelper().then((h) => live && setState((s) => ({ ...s, ...h })))
    }
    return () => {
      live = false
    }
  }, [])
  return [state, setState]
}

/** True once, right after returning from "Connect OpenRouter". */
export function takeOpenSettingsFlag(): boolean {
  const set = sessionStorage.getItem(OPEN_SETTINGS_FLAG) === '1'
  // Cleared a tick later so StrictMode's double initializer call sees it both times.
  if (set) setTimeout(() => sessionStorage.removeItem(OPEN_SETTINGS_FLAG), 0)
  return set
}
