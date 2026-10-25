// Page document model. Units are PDF points (1/72 inch). See docs/ARCHITECTURE.md §4.1.
// Items are immutable: every edit replaces the item object, which keeps undo and
// render caches simple.

export type StrokeTool = 'pen' | 'highlighter'

export type Stroke = {
  kind: 'stroke'
  id: string
  tool: StrokeTool
  color: string
  width: number
  /** Flat [x, y, t, x, y, t, …]; t is milliseconds since the stroke started. */
  points: number[]
  author: 'user' | 'ai'
  groupId?: string
}

export type ImageItem = {
  kind: 'image'
  id: string
  assetId: string
  x: number
  y: number
  w: number
  h: number
}

export type TextItem = {
  kind: 'text'
  id: string
  x: number
  y: number
  w: number
  h: number
  text: string
  size: number
  color: string
}

export type Item = Stroke | ImageItem | TextItem

/** What an AI ink group says, so Writey can re-read its own writing exactly (docs §4.1). */
export type AiSource = { source: string; why?: string }

export type PageDoc = {
  v: 1
  items: Item[]
  /** Sources of AI ink, by stroke groupId. */
  ai?: Record<string, AiSource>
}

export const emptyPage = (): PageDoc => ({ v: 1, items: [] })

export const newId = (): string => crypto.randomUUID()

export type Rect = { x: number; y: number; w: number; h: number }
