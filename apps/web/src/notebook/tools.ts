import type { AiSource, Item, Rect } from '@writey/ink-engine'
import type { Written } from '@writey/inkscript'
import type { AssetRow } from '@writey/shared'

export type ToolId = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'text'

export type PenStyle = { color: string; width: number }

/** size: the eraser's diameter in screen pixels. 'stroke' removes whole strokes it touches. */
export type EraserStyle = { size: number; mode: 'partial' | 'stroke' }

export type ToolState = {
  tool: ToolId
  pen: PenStyle
  highlighter: PenStyle
  eraser: EraserStyle
  textSize: number
}

export const PEN_COLORS = ['#16171d', '#2f4bf0', '#f0304f', '#0f9d6b', '#e07a10', '#7a3fd0']
export const PEN_PRESETS: PenStyle[] = PEN_COLORS.map((color) => ({ color, width: 1.6 }))
/** Pen widths in points: the presets, and the slider's range. */
export const PEN_WIDTHS = [0.8, 1.6, 2.6, 4]
export const PEN_RANGE = { min: 0.5, max: 8, step: 0.1 }
export const HIGHLIGHTER_COLORS = ['#ffe14a', '#7ff0a6', '#ffa8cb', '#8fd3ff', '#ffc078']
export const HIGHLIGHTER_WIDTHS = [8, 14, 22]
export const ERASER_SIZES = [10, 18, 32, 56]

export const DEFAULT_TOOLS: ToolState = {
  tool: 'pen',
  pen: PEN_PRESETS[0] as PenStyle,
  highlighter: { color: HIGHLIGHTER_COLORS[0] as string, width: 14 },
  eraser: { size: 18, mode: 'partial' },
  textSize: 14,
}

export const TOOL_KEYS: Record<string, ToolId> = {
  p: 'pen',
  h: 'highlighter',
  e: 'eraser',
  l: 'lasso',
  t: 'text',
}

/** A round cursor: a dot in the pen's color where the ink lands (no pencil icon). */
export function dotCursor(fill: string, size: number, ring = '#fff'): string {
  const d = 2 * Math.round(Math.min(24, Math.max(7, size)) / 2)
  const s = d + 4
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}'><circle cx='${s / 2}' cy='${s / 2}' r='${d / 2}' fill='${fill}' stroke='${ring}' stroke-width='1.5'/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${s / 2} ${s / 2}, crosshair`
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
  /** True once the page's ink has loaded and it can take new ink. */
  isLoaded(): boolean
  /** What the help engine needs to see this page. */
  snapshot(): PageSnapshot
  /** AI ink preview (docs §5.7): starts empty, grows block by block while the answer streams. */
  ghostStart(actions: GhostActions): void
  ghostAdd(block: Written): void
  /** The answer finished streaming; the bar shows Accept / Redo / Discard / Why?. */
  ghostEnd(): void
  /** Accepts or throws away the current preview. Returns false if there is none. */
  ghostAccept(): boolean
  ghostDiscard(): boolean
  /** Throws the preview away and asks again. */
  ghostRedo(): boolean
  hasGhost(): boolean
}

/** What the ghost bar's Redo and Why? do: the chat panel owns those. */
export type GhostActions = {
  redo(): void
  why(): void
  /** Called once the preview is accepted or discarded (or replaced). */
  settled(outcome: 'accepted' | 'discarded'): void
}

/** What the page shows over its ink while a preview is up. */
export type GhostView = {
  /** Bounds of the preview, page points. */
  rect: Rect
  writing: boolean
}

export type PageSnapshot = {
  items: readonly Item[]
  /** Items the user wrote in the last minute or so (docs §5.1). */
  recent: ReadonlySet<string>
  /** Bounds of the lasso selection, if any. */
  selection: Rect | null
  /** Exact source of an AI ink group. */
  aiSource(groupId: string): AiSource | undefined
  /** Spoken transcript to send along (set by the help engine's caller). */
  transcript?: string
}

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

/** In-app clipboard for lasso copy/paste (works across pages). */
export const clipboard: { items: Item[] } = { items: [] }
