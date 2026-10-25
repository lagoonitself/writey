import type { AiProvider } from '@writey/shared'

export const PROVIDER_LABEL: Record<AiProvider, string> = {
  openrouter: 'OpenRouter',
  'opencode-zen': 'OpenCode Zen',
  chatgpt: 'ChatGPT',
}

export type ModelInfo = {
  id: string
  name: string
  /** Who makes it ("DeepSeek"), for grouping. */
  vendor: string
  /** US dollars per million input and output tokens, when the provider says. */
  price?: { input: number; output: number }
  /** null when the provider doesn't say. */
  vision: boolean | null
  /** False for models Writey can't call yet; `note` says why. */
  supported: boolean
  note?: string
}

// Zen serves these families over other wire formats (Responses, Messages, Gemini).
// Writey speaks Chat Completions only for now.
const ZEN_OTHER_FORMAT = /^(gpt-|o\d|grok-|muse-|claude-|gemini-|jev-|qwen3\.\d+-(flash|plus))/
const ZEN_VISION = /deepseek-v4\.1-flash|-vl\b|-vl-|vision/

/** Good picks for reading handwriting, best first; only the ones a provider lists are shown. */
export const RECOMMENDED: Record<AiProvider, readonly string[]> = {
  openrouter: [
    'deepseek/deepseek-v4.1-flash',
    'google/gemini-4-argon',
    'anthropic/claude-sonnet-5.5',
    'openai/gpt-6.1-sol',
    'anthropic/claude-haiku-5.5',
    'moonshotai/kimi-k3.1-pro',
  ],
  'opencode-zen': ['deepseek-v4.1-flash', 'kimi-k3.1-pro', 'glm-5.3'],
  chatgpt: [],
}

const perMillion = (v: unknown) => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : Number.NaN
  return Number.isFinite(n) && n >= 0 ? n * 1e6 : null
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

type RawModel = {
  id?: unknown
  name?: unknown
  architecture?: { input_modalities?: unknown }
  pricing?: { prompt?: unknown; completion?: unknown }
  slug?: unknown
  display_name?: unknown
  input_modalities?: unknown
}

/** Normalizes a provider's model list response. */
export function parseModels(provider: AiProvider, json: unknown): ModelInfo[] {
  if (provider === 'chatgpt') return chatgptModels(json)
  const data = (json as { data?: RawModel[] } | null)?.data
  if (!Array.isArray(data)) return []
  const models: ModelInfo[] = []
  for (const m of data) {
    if (typeof m.id !== 'string') continue
    if (provider === 'openrouter') {
      // Batch variants answer hours later, which is no use while you're writing;
      // "~" ids are moving aliases for other models.
      if (m.id.endsWith(':batch') || m.id.startsWith('~')) continue
      const inputs = m.architecture?.input_modalities
      const full = typeof m.name === 'string' ? m.name : m.id
      const [vendor, name] = full.includes(': ')
        ? full.split(/: (.*)/s)
        : [m.id.split('/')[0], full]
      const input = perMillion(m.pricing?.prompt)
      const output = perMillion(m.pricing?.completion)
      models.push({
        id: m.id,
        name: name || full,
        vendor: vendor || 'Other',
        price: input !== null && output !== null ? { input, output } : undefined,
        vision: Array.isArray(inputs) ? inputs.includes('image') : null,
        supported: true,
      })
    } else {
      if (m.id === 'test') continue
      const free = m.id.endsWith('-free')
      const other = ZEN_OTHER_FORMAT.test(m.id)
      models.push({
        id: m.id,
        name: m.id,
        vendor: capitalize(m.id.split('-')[0] ?? m.id),
        vision: ZEN_VISION.test(m.id) ? true : null,
        supported: !free && !other,
        note: free
          ? 'Free models only work inside the OpenCode app'
          : other
            ? 'Not supported yet'
            : undefined,
      })
    }
  }
  return models.sort((a, b) => `${a.vendor} ${a.name}`.localeCompare(`${b.vendor} ${b.name}`))
}

/** The Helper's ChatGPT list: models the signed-in plan can use (visibility "list"). */
function chatgptModels(json: unknown): ModelInfo[] {
  const data = (json as { models?: RawModel[] } | null)?.models
  if (!Array.isArray(data)) return []
  return data.flatMap((m): ModelInfo[] => {
    if (typeof m.slug !== 'string') return []
    const inputs = m.input_modalities
    return [
      {
        id: m.slug,
        name: typeof m.display_name === 'string' ? m.display_name : m.slug,
        vendor: 'OpenAI',
        vision: Array.isArray(inputs) ? inputs.includes('image') : null,
        supported: true,
      },
    ]
  })
}
