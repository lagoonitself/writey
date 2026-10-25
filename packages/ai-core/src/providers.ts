import type { KeyProvider } from '@writey/shared'

export const PROVIDER_LABEL: Record<KeyProvider, string> = {
  openrouter: 'OpenRouter',
  'opencode-zen': 'OpenCode Zen',
}

export type ModelInfo = {
  id: string
  name: string
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

type RawModel = { id?: unknown; name?: unknown; architecture?: { input_modalities?: unknown } }

/** Normalizes a provider's model list response. */
export function parseModels(provider: KeyProvider, json: unknown): ModelInfo[] {
  const data = (json as { data?: RawModel[] } | null)?.data
  if (!Array.isArray(data)) return []
  const models: ModelInfo[] = []
  for (const m of data) {
    if (typeof m.id !== 'string') continue
    if (provider === 'openrouter') {
      const inputs = m.architecture?.input_modalities
      models.push({
        id: m.id,
        name: typeof m.name === 'string' ? m.name : m.id,
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
  return models.sort((a, b) => a.name.localeCompare(b.name))
}
