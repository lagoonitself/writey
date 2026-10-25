/** Thinking providers (HANDOFF D11). */
export const AI_PROVIDERS = ['openrouter', 'opencode-zen', 'chatgpt'] as const
export type AiProvider = (typeof AI_PROVIDERS)[number]

/** Providers whose API keys Writey stores, encrypted. ChatGPT signs in through the Helper. */
export const KEY_PROVIDERS = ['openrouter', 'opencode-zen'] as const
export type KeyProvider = (typeof KEY_PROVIDERS)[number]

export const isKeyProvider = (s: string): s is KeyProvider =>
  (KEY_PROVIDERS as readonly string[]).includes(s)

/** What the browser may know about a saved key. Never the key itself. */
export type CredentialInfo = {
  provider: KeyProvider
  label: string | null
  last4: string
  created_at: string
}

export type SaveCredentialBody = { key: string; label?: string }

/** Per-user AI choice, stored in `profiles.settings.ai`. */
export type AiSettings = { provider: KeyProvider; model: string }

export const DEFAULT_AI: AiSettings = {
  provider: 'openrouter',
  model: 'deepseek/deepseek-v4.1-flash',
}

export const KEY_MAX_LENGTH = 512

/** Model requests carry page images, so they are bigger than most API calls. */
export const AI_BODY_MAX_BYTES = 8 * 1024 * 1024

export type HealthResponse = { ok: true; service: 'writey-worker'; time: string }

export type MeResponse = { userId: string; email: string | null }

export type ApiError = { error: string }

// ---------------------------------------------------------------------------
// Notebooks, pages, assets (rows as the client sees them)
// ---------------------------------------------------------------------------

export type PageBackground =
  | { kind: 'blank' }
  | { kind: 'pdf'; assetId: string; pdfPage: number }
  | { kind: 'image'; assetId: string }

export type NotebookRow = {
  id: string
  title: string
  sort_key: string
  created_at: string
  updated_at: string
}

export type PageRow = {
  id: string
  notebook_id: string
  sort_key: string
  width: number
  height: number
  background: PageBackground
  version: number
}

export type AssetKind = 'pdf' | 'image'

export type AssetRow = {
  id: string
  kind: AssetKind
  bytes: number
  sha256: string
  page_count: number | null
  created_at: string
}

/** Returned with HTTP 409 when a page save was based on a stale version. */
export type VersionConflict = { error: 'version_conflict'; version: number }

/** Header carrying a page's content version on GET and PUT /api/pages/:id/content. */
export const PAGE_VERSION_HEADER = 'X-Page-Version'

export const PAGE_MAX_BYTES = 5 * 1024 * 1024

export const ASSET_MAX_BYTES: Record<AssetKind, number> = {
  pdf: 50 * 1024 * 1024,
  image: 15 * 1024 * 1024,
}

export const ASSET_MIME: Record<AssetKind, readonly string[]> = {
  pdf: ['application/pdf'],
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}
