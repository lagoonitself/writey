/** Thinking providers. Gemini is used for voice only and is not in this list. */
export const AI_PROVIDERS = ['openrouter', 'opencode-zen', 'chatgpt'] as const
export type AiProvider = (typeof AI_PROVIDERS)[number]

export type HealthResponse = { ok: true; service: 'writey-worker'; time: string }

export type MeResponse = { userId: string; email: string | null }

export type ApiError = { error: string }
