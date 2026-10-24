import type { Item } from '@writey/ink-engine'
import type { AssetRow } from '@writey/shared'

export type ToolId = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'text'

export type PenStyle = { color: string; width: number }

export type ToolState = {
  tool: ToolId
  pen: PenStyle
  highlighter: PenStyle
  textSize: number
}

export const PEN_PRESETS: PenStyle[] = [
  { color: '#1a1a1a', width: 1.6 },
  { color: '#2b59c3', width: 1.6 },
  { color: '#c0392b', width: 1.6 },
]
export const PEN_WIDTHS = [1, 1.6, 2.6, 4]
export const HIGHLIGHTER_COLORS = ['#ffe94d', '#8ef0a0', '#ffb3d1', '#9ad7ff']

export const DEFAULT_TOOLS: ToolState = {
  tool: 'pen',
  pen: PEN_PRESETS[0] as PenStyle,
  highlighter: { color: HIGHLIGHTER_COLORS[0] as string, width: 14 },
  textSize: 14,
}

export const TOOL_KEYS: Record<string, ToolId> = {
  p: 'pen',
  h: 'highlighter',
  e: 'eraser',
  l: 'lasso',
  t: 'text',
}

/** What the notebook view can ask of a mounted page. */
export type PageHandle = {
  undo(): void
  redo(): void
  canUndo(): boolean
  canRedo(): boolean
  hasSelection(): boolean
  /** Recolors the selection; returns false if nothing is selected. */
  recolor(color: string): boolean
  insertImage(asset: AssetRow, width: number, height: number): void
  /** Saves now if there are unsaved edits. */
  flush(): Promise<void>
  isDirty(): boolean
}

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

/** In-app clipboard for lasso copy/paste (works across pages). */
export const clipboard: { items: Item[] } = { items: [] }
