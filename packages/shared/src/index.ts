/** Thinking providers. Gemini is used for voice only and is not in this list. */
export const AI_PROVIDERS = ['openrouter', 'opencode-zen', 'chatgpt'] as const
export type AiProvider = (typeof AI_PROVIDERS)[number]

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
