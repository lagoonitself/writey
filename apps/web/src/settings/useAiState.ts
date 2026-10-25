import { type AiSettings, type CredentialInfo, DEFAULT_AI } from '@writey/shared'
import { useEffect, useState } from 'react'
import { listCredentials, loadAiSettings } from '../lib/ai'

export type AiState = { settings: AiSettings; credentials: CredentialInfo[] }

/** Set by the OpenRouter callback so the next screen opens Settings to show the result. */
export const OPEN_SETTINGS_FLAG = 'writey.openSettings'

export function useAiState(): [AiState, (next: AiState) => void] {
  const [state, setState] = useState<AiState>({ settings: DEFAULT_AI, credentials: [] })
  useEffect(() => {
    let live = true
    Promise.all([loadAiSettings(), listCredentials()])
      .then(([settings, credentials]) => live && setState({ settings, credentials }))
      .catch((e) => console.error('AI settings failed to load', e))
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
