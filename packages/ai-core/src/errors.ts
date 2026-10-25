import type { KeyProvider } from '@writey/shared'
import { PROVIDER_LABEL } from './providers'

/**
 * A failed request, said plainly (docs §6.4). `settings` means the fix is in Settings;
 * `link` is an outside page that helps (ChatGPT usage).
 */
export type HelpError = {
  message: string
  settings?: boolean
  link?: { label: string; url: string }
}

export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'

function detail(body: string): { code: string; message: string } {
  try {
    const json = JSON.parse(body) as { error?: unknown; message?: unknown }
    if (typeof json.error === 'string') {
      return { code: json.error, message: typeof json.message === 'string' ? json.message : '' }
    }
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

const MANAGE_USAGE = { label: 'Manage usage', url: CHATGPT_USAGE_URL }

/**
 * ChatGPT plan usage errors, from the Helper or from OpenAI (SIWC errors and recovery).
 * `code` comes from a mid-stream failure; otherwise it's read from the body.
 */
export function describeChatgptError(status: number, body: string, code?: string): HelpError {
  const d = detail(body)
  const c = code ?? d.code
  switch (c) {
    case 'helper_offline':
      return {
        message:
          'Writey Helper isn’t running on this computer, so ChatGPT can’t answer. Settings shows how to start it.',
        settings: true,
      }
    case 'signed_out':
    case 'session_expired':
    case 'subscription_sharing_invalid_user':
      return {
        message: 'Your ChatGPT sign-in ended. Sign in again in Settings.',
        settings: true,
      }
    case 'plan_usage_disabled':
      return {
        message: 'ChatGPT plan usage isn’t enabled for Writey. Sign in again and allow it.',
        settings: true,
      }
    case 'subscription_sharing_usage_limit_exceeded':
      return {
        message:
          'You’ve reached a usage limit for your ChatGPT plan. Check your usage in ChatGPT settings.',
        link: MANAGE_USAGE,
      }
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return { message: 'ChatGPT usage couldn’t be checked right now. Try again in a moment.' }
    case 'subscription_sharing_user_not_eligible':
      return { message: 'ChatGPT plan usage isn’t available for this account or workspace.' }
    case 'subscription_sharing_unsupported_capability':
      return {
        message:
          'That model or feature isn’t supported with ChatGPT plan usage. Pick another model in Settings.',
        settings: true,
      }
    case 'incomplete':
    case 'interrupted':
      return { message: d.message || 'ChatGPT stopped before finishing. Try again.' }
  }
  if (status === 401) {
    return {
      message: 'Your ChatGPT sign-in couldn’t be verified. Sign in again in Settings.',
      settings: true,
    }
  }
  if (status === 403)
    return { message: 'ChatGPT plan usage isn’t available for this request (access restriction).' }
  if (status === 429)
    return { message: 'ChatGPT is limiting requests right now.', link: MANAGE_USAGE }
  if (status >= 500) return { message: 'ChatGPT is temporarily unavailable. Try again shortly.' }
  return { message: d.message ? `ChatGPT: ${d.message}` : `The request failed (${status}).` }
}
