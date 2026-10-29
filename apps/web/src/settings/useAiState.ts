import { type AiProvider, type AiSettings, type CredentialInfo, DEFAULT_AI } from '@writey/shared'
import { useEffect, useState } from 'react'
import { listCredentials, loadAiSettings } from '../lib/ai'
import { type ChatgptStatus, chatgptStatus } from '../lib/chatgpt'

export type AiState = {
  settings: AiSettings
  credentials: CredentialInfo[]
  /** How the ChatGPT sign-in stands; null until checked. */
  chatgpt: ChatgptStatus | null
  /** Why saved keys couldn't be read (the keychain lost the vault key), if so. */
  vaultError?: string
}

/** Whether asking with this provider can work right now. */
export function usable(ai: AiState, provider: AiProvider): boolean {
  if (provider === 'chatgpt') return Boolean(ai.chatgpt?.signed_in && ai.chatgpt.plan_usage)
  return ai.credentials.some((c) => c.provider === provider)
}

export function useAiState(): [AiState, (next: AiState) => void] {
  const [state, setState] = useState<AiState>({
    settings: DEFAULT_AI,
    credentials: [],
    chatgpt: null,
  })
  useEffect(() => {
    let live = true
    Promise.allSettled([loadAiSettings(), listCredentials(), chatgptStatus()]).then(
      ([settings, credentials, chatgpt]) => {
        if (!live) return
        const failed = [credentials, chatgpt].find((r) => r.status === 'rejected')
        setState((s) => ({
          ...s,
          settings: settings.status === 'fulfilled' ? settings.value : s.settings,
          credentials: credentials.status === 'fulfilled' ? credentials.value : [],
          chatgpt: chatgpt.status === 'fulfilled' ? chatgpt.value : null,
          vaultError: failed?.status === 'rejected' ? (failed.reason as Error).message : undefined,
        }))
      },
    )
    return () => {
      live = false
    }
  }, [])
  return [state, setState]
}
