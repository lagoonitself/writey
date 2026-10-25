import type { KeyProvider } from '@writey/shared'
import { PROVIDER_LABEL } from './providers'

/** A failed request, said plainly (docs §6.4). `settings` means the fix is in Settings. */
export type HelpError = { message: string; settings?: boolean }

function detail(body: string): { code: string; message: string } {
  try {
    const json = JSON.parse(body) as { error?: unknown; message?: unknown }
    if (typeof json.error === 'string') return { code: json.error, message: '' }
    const err = json.error as { message?: unknown; code?: unknown } | undefined
    const message = typeof err?.message === 'string' ? err.message : ''
    return { code: typeof err?.code === 'string' ? err.code : '', message }
  } catch {
    return { code: '', message: body.slice(0, 200) }
  }
}

export function describeError(
  provider: KeyProvider,
  model: string,
  status: number,
  body: string,
): HelpError {
  const name = PROVIDER_LABEL[provider]
  const { code, message } = detail(body)
  if (code === 'no_key')
    return { message: `Add your ${name} key in Settings to ask Writey.`, settings: true }
  if (code === 'key_unreadable') {
    return {
      message: `Your saved ${name} key can't be read. Add it again in Settings.`,
      settings: true,
    }
  }
  if (status === 401 || status === 403) {
    return { message: `${name} didn't accept your API key. Check it in Settings.`, settings: true }
  }
  if (status === 402) return { message: `Your ${name} account is out of credits.` }
  if (status === 429)
    return { message: `${name} is rate limiting you. Wait a moment and try again.` }
  if (status === 413)
    return { message: 'That was too much to send. Lasso a smaller area and try again.' }
  if (status === 404 || /model.*(not found|does not exist|invalid)/i.test(message)) {
    return {
      message: `${name} doesn't have the model "${model}". Pick another in Settings.`,
      settings: true,
    }
  }
  if (/image|vision|multimodal/i.test(message)) {
    return {
      message: `"${model}" can't read images. Pick a vision model in Settings.`,
      settings: true,
    }
  }
  if (status >= 500) return { message: `${name} had a problem. Try again in a moment.` }
  return { message: message ? `${name}: ${message}` : `The request failed (${status}).` }
}
