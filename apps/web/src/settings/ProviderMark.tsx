import type { AiProvider } from '@writey/shared'
import { ChatgptIcon } from '../notebook/icons'

/** A small tile that tells the providers apart at a glance. */
export function ProviderMark({ provider }: { provider: AiProvider }) {
  if (provider === 'chatgpt') {
    return (
      <span className="provider-mark" aria-hidden="true">
        <ChatgptIcon size={18} />
      </span>
    )
  }
  return (
    <span
      className={`provider-mark ${provider === 'openrouter' ? 'openrouter' : 'zen'}`}
      aria-hidden="true"
    >
      {provider === 'openrouter' ? 'OR' : 'zen'}
    </span>
  )
}
