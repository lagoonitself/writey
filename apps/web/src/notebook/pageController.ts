import {
  drawItems,
  drawStroke,
  eraseStroke,
  hitItem,
  type Item,
  itemInLasso,
  layoutText,
  newId,
  PageEditor,
  type Rect,
  rectContains,
  type StrokeTool,
  scaleItem,
  TEXT_LINE_HEIGHT,
  type TextItem,
  translateItem,
  unionBounds,
} from '@writey/ink-engine'
import { PICTURE_MS, type Written } from '@writey/inkscript'
import type { AssetRow, PageRow } from '@writey/shared'
import { loadImage } from '../lib/assets'
import { ask } from '../lib/dialogs'
import { NativeError } from '../lib/native'
import { backupPage, clearBackup, loadPage, savePage } from '../lib/pageStore'
import { renderPdfPage } from '../lib/pdf'
import {
  clipboard,
  type GhostActions,
  type GhostView,
  type PageHandle,
  type PageSnapshot,
  type SaveState,
  type ToolId,
  type ToolState,
} from './tools'

/** Per canvas. Three canvases per mounted page; Chrome blanks canvases (black) past its GPU budget. */
const MAX_CANVAS_PIXELS = 8_000_000
const HANDLE_PX = 12
const SAVE_DELAY_MS = 1500
const RETRY_DELAY_MS = 5000
const SELECTION_COLOR = '#2f4bf0'
/** Writing this recent marks where the user is working (docs §5.1). */
const RECENT_MS = 90_000
/** AI ink preview opacity (docs §5.7). */
const GHOST_ALPHA = 0.45
/** Writey's pen cursor and its touch-down ripple. */
const WRITEY_INK = '#5b3fb5'
const TOUCH_MS = 260

/** AI ink being previewed: blocks arrive while the answer streams and animate in. */
type Ghost = {
  blocks: { written: Written; offset: number }[]
  /** Offset of the latest block: later ones never start before it. */
  offset: number
  /** performance.now() when writing started. */
  start: number
  writing: boolean
  /** Shown in full at once (the Skip button). */
  skipped: boolean
  actions: GhostActions
}

type LiveStroke = { tool: StrokeTool; color: string; width: number; points: number[] }

type Gesture =
  | { type: 'draw'; live: LiveStroke; t0: number }
  /** `items` is the page as erased so far; `origin` maps each cut piece to the stroke it came from. */
  | { type: 'erase'; items: Item[]; origin: Map<string, string>; touched: Set<string> }
  | { type: 'lasso'; poly: number[] }
  | { type: 'move'; x0: number; y0: number; dx: number; dy: number }
  | { type: 'scale'; ox: number; oy: number; d0: number; s: number }

export type TextEdit = {
  id: string | null
  x: number
  y: number
  w: number
  text: string
  size: number
  color: string
}

export type PageCallbacks = {
  onHistory(): void
  onSaveState(state: SaveState): void
  onTextEdit(edit: TextEdit | null): void
  onActivate(): void
  onRequestTool(tool: ToolId): void
  onGhost(view: GhostView | null): void
}

/**
 * Everything imperative about one page: canvases, pointer gestures, selection,
 * and load/save. The React component only mounts it and forwards events.
 */
export class PageController {
  readonly editor = new PageEditor()
  readonly handle: PageHandle
  tools: ToolState

  private bg: HTMLCanvasElement | null = null
  private ink: HTMLCanvasElement | null = null
  private wet: HTMLCanvasElement | null = null
  private scale = 1
  private ratio = 1
  private gesture: Gesture | null = null
  private selection = new Set<string>()
  /** Items left off the ink layer while they are being moved, erased or edited. */
  private hidden = new Set<string>()
  private images = new Map<string, HTMLImageElement | null>()
  private cancelBackground: (() => void) | null = null
  private wetFrame = 0
  /** Where the eraser ring is drawn, in page units. */
  private hover: [number, number] | null = null
  /** When the user wrote each item this session. */
  private written = new Map<string, number>()
  private ghost: Ghost | null = null
  /** The wet layer's cursor, put back after a stroke. */
  private cursor = ''

  private loaded = false
  private version = 0
  private savedRevision = 0
  private saving: Promise<void> | null = null
  private saveTimer = 0
  private backupTimer = 0

  constructor(
    private readonly page: PageRow,
    tools: ToolState,
    private readonly cb: PageCallbacks,
  ) {
    this.tools = tools
    this.editor.subscribe(() => this.onEditorChange())
    this.handle = {
      undo: () => this.editor.undo(),
      redo: () => this.editor.redo(),
      canUndo: () => this.editor.canUndo,
      canRedo: () => this.editor.canRedo,
      hasSelection: () => this.selection.size > 0,
      recolor: (color) => this.recolor(color),
      insertImage: (asset, w, h) => this.insertImage(asset, w, h),
      flush: () => this.flush(),
      isDirty: () => this.isDirty(),
      reloadIfClean: async () => {
        if (this.loaded && !this.isDirty() && !this.saving) await this.load()
      },
      isLoaded: () => this.loaded,
      snapshot: (withGhost) => this.snapshot(withGhost),
      ghostStart: (actions) => this.ghostStart(actions),
      ghostAdd: (block) => this.ghostAdd(block),
      ghostErase: (groupId) => this.ghostErase(groupId),
      ghostEnd: () => this.ghostEnd(),
      ghostAccept: () => this.ghostAccept(),
      ghostDiscard: () => this.ghostDiscard(),
      ghostRedo: () => {
        if (!this.ghost || this.ghost.writing) return false
        this.ghostAction('redo')
        return true
      },
      hasGhost: () => Boolean(this.ghost?.blocks.length),
    }
  }

  private snapshot(withGhost = false): PageSnapshot {
    const since = Date.now() - RECENT_MS
    const recent = new Set<string>()
    for (const [id, at] of this.written) if (at >= since) recent.add(id)
    // Writey looking at its own preview between rounds: the preview counts as the newest work.
    const ghost = withGhost ? (this.ghost?.blocks.map((b) => b.written) ?? []) : []
    const strokes = ghost.flatMap((w) => w.strokes.map((s) => s.stroke))
    const pictures = ghost.flatMap((w) => w.items ?? [])
    for (const s of strokes) recent.add(s.id)
    const sources = new Map(ghost.map((w) => [w.groupId, { source: w.source }]))
    const extra = [...pictures, ...strokes]
    return {
      items: extra.length ? [...this.editor.items, ...extra] : this.editor.items,
      recent,
      selection: unionBounds(this.selectedItems()),
      aiSource: (groupId) => this.editor.aiSource(groupId) ?? sources.get(groupId),
    }
  }

  // -------------------------------------------------------------------------
  // AI ink preview (docs §5.7)
  // -------------------------------------------------------------------------

  private ghostStart(actions: GhostActions): void {
    if (this.ghost) this.settleGhost('discarded')
    this.ghost = {
      blocks: [],
      offset: 0,
      start: performance.now(),
      writing: true,
      skipped: false,
      actions,
    }
    this.emitGhost()
  }

  private ghostAdd(written: Written): void {
    const g = this.ghost
    if (!g) return
    const first = written.at ?? written.strokes[0]?.at ?? 0
    g.blocks.push({ written, offset: this.ghostOffset(g, first) })
    this.emitGhost()
    this.requestWet()
  }

  /** A block that arrives after its turn starts now instead of popping in half-written. */
  private ghostOffset(g: Ghost, first: number): number {
    g.offset = Math.max(g.offset, performance.now() - g.start - first)
    return g.offset
  }

  /** Writey rubs out one of its own preview blocks. */
  private ghostErase(groupId: string): void {
    const g = this.ghost
    if (!g) return
    g.blocks = g.blocks.filter((b) => b.written.groupId !== groupId)
    this.emitGhost()
    this.requestWet()
  }

  private ghostEnd(): void {
    if (!this.ghost) return
    if (!this.ghost.blocks.length) {
      // Nothing was written here: nothing to accept, and the other pages' preview stays.
      this.ghost = null
      this.emitGhost()
      this.requestWet()
      return
    }
    this.ghost.writing = false
    this.emitGhost()
    this.requestWet()
  }

  /** Shows the whole preview at once instead of waiting for the animation. */
  skipGhost(): void {
    if (!this.ghost) return
    this.ghost.skipped = true
    this.requestWet()
  }

  private ghostAccept(): boolean {
    const g = this.ghost
    if (!g?.blocks.length) return false
    const strokes = g.blocks.flatMap((b) => b.written.strokes.map((s) => s.stroke))
    const pictures = g.blocks.flatMap((b) => b.written.items ?? [])
    const sources = Object.fromEntries(
      g.blocks.map(({ written: w }) => [
        w.groupId,
        w.why ? { source: w.source, why: w.why } : { source: w.source },
      ]),
    )
    // Writey's lines count as recent work, so "continue" carries on from them.
    const now = Date.now()
    for (const s of strokes) this.written.set(s.id, now)
    this.settleGhost('accepted')
    // Pictures go under the ink, so names and leader lines sit on top of them.
    this.editor.addAi([...pictures, ...strokes], sources)
    return true
  }

  private ghostDiscard(): boolean {
    if (!this.ghost) return false
    this.settleGhost('discarded')
    return true
  }

  /** Runs a ghost bar button. */
  ghostAction(action: 'accept' | 'discard' | 'redo' | 'why' | 'skip'): void {
    const g = this.ghost
    if (!g) return
    if (action === 'accept') this.ghostAccept()
    else if (action === 'discard') this.ghostDiscard()
    else if (action === 'skip') this.skipGhost()
    else if (action === 'redo') {
      this.settleGhost('discarded')
      g.actions.redo()
    } else g.actions.why()
  }

  private settleGhost(outcome: 'accepted' | 'discarded'): void {
    const g = this.ghost
    if (!g) return
    this.ghost = null
    this.emitGhost()
    this.requestWet()
    g.actions.settled(outcome)
  }

  private emitGhost(): void {
    const g = this.ghost
    const rects = g?.blocks.map((b) => b.written.rect) ?? []
    if (!g || (!rects.length && !g.writing)) {
      this.cb.onGhost(null)
      return
    }
    const x0 = Math.min(...rects.map((r) => r.x))
    const y0 = Math.min(...rects.map((r) => r.y))
    const x1 = Math.max(...rects.map((r) => r.x + r.w))
    const y1 = Math.max(...rects.map((r) => r.y + r.h))
    this.cb.onGhost({
      rect: rects.length ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 },
      writing: g.writing,
    })
  }

  /** Draws the preview as far as it has been written. Returns true while still animating. */
  private drawGhost(ctx: CanvasRenderingContext2D): boolean {
    const g = this.ghost
    if (!g) return false
    const elapsed = g.skipped ? Number.POSITIVE_INFINITY : performance.now() - g.start
    let animating = false
    ctx.save()
    // Pasted pictures fade in, under the preview's ink.
    for (const { written, offset } of g.blocks) {
      if (!written.items?.length) continue
      const local = elapsed - ((written.at ?? 0) + offset)
      if (local < 0) {
        animating = true
        continue
      }
      if (local < PICTURE_MS) animating = true
      ctx.globalAlpha = GHOST_ALPHA * Math.min(1, local / PICTURE_MS)
      drawItems(ctx, written.items, { images: this.image })
    }
    ctx.globalAlpha = GHOST_ALPHA
    for (const { written, offset } of g.blocks) {
      for (const { stroke, at } of written.strokes) {
        const local = elapsed - (at + offset)
        if (local < 0) {
          animating = true
          continue
        }
        const end = stroke.points[stroke.points.length - 1] as number
        if (local >= end) {
          drawStroke(ctx, stroke)
          continue
        }
        animating = true
        let n = 3
        while (n < stroke.points.length && (stroke.points[n + 2] as number) <= local) n += 3
        drawStroke(ctx, { ...stroke, points: stroke.points.slice(0, n) }, { live: true })
      }
    }
    ctx.restore()
    if (!g.skipped) {
      this.drawWriteyPen(ctx, g, elapsed)
    }
    return animating
  }

  /**
   * Writey's pen: where it is writing now, gliding between strokes while lifted, with a small
   * ripple each time it touches down. It stays parked at the last stroke while more is coming.
   */
  private drawWriteyPen(ctx: CanvasRenderingContext2D, g: Ghost, elapsed: number): void {
    let tip: [number, number] | null = null
    let down = false
    let touch: { x: number; y: number; age: number } | null = null
    let prev: { x: number; y: number; t: number } | null = null
    let next: { x: number; y: number; t: number } | null = null
    for (const { written, offset } of g.blocks) {
      for (const { stroke, at } of written.strokes) {
        const p = stroke.points
        const start = at + offset
        const end = start + (p[p.length - 1] as number)
        if (elapsed >= end) {
          if (!prev || end >= prev.t)
            prev = { x: p[p.length - 3] as number, y: p[p.length - 2] as number, t: end }
          continue
        }
        if (elapsed < start) {
          if (!next || start < next.t) next = { x: p[0] as number, y: p[1] as number, t: start }
          continue
        }
        const local = elapsed - start
        let i = 0
        while (i + 3 < p.length && (p[i + 5] as number) <= local) i += 3
        tip = [p[i] as number, p[i + 1] as number]
        down = true
        if (local < TOUCH_MS) touch = { x: p[0] as number, y: p[1] as number, age: local }
      }
    }
    let label = 'Writey'
    if (!tip) {
      if (prev && next) {
        const u = Math.min(1, Math.max(0, (elapsed - prev.t) / Math.max(1, next.t - prev.t)))
        const e = u * u * (3 - 2 * u)
        tip = [prev.x + (next.x - prev.x) * e, prev.y + (next.y - prev.y) * e]
      } else if (next) tip = [next.x, next.y]
      else if (prev && g.writing) {
        tip = [prev.x, prev.y]
        label = 'Writey · thinking…'
      }
    }
    if (!tip) return
    const px = 1 / this.scale
    ctx.save()
    if (touch) {
      // The "click" of the pen touching the paper.
      const k = touch.age / TOUCH_MS
      ctx.beginPath()
      ctx.arc(touch.x, touch.y, (3 + k * 9) * px, 0, Math.PI * 2)
      ctx.strokeStyle = WRITEY_INK
      ctx.globalAlpha = 0.45 * (1 - k)
      ctx.lineWidth = 1.5 * px
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    // Lifted pens float a little up and to the right of the paper.
    const lift = down ? 0 : 5 * px
    ctx.translate(tip[0] + lift, tip[1] - lift)
    ctx.scale(px, px)
    ctx.rotate(Math.PI / 5)
    ctx.lineJoin = 'round'
    // Nib, then the barrel, leaning up and to the right like a pen in a right hand.
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(4, -9)
    ctx.lineTo(-4, -9)
    ctx.closePath()
    ctx.fillStyle = '#2b1d63'
    ctx.fill()
    ctx.beginPath()
    ctx.roundRect(-4.5, -34, 9, 25, 2.5)
    ctx.fillStyle = WRITEY_INK
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#fff'
    ctx.stroke()
    ctx.rotate(-Math.PI / 5)
    // The name tag, like a collaborator's cursor, below and to the right of the tip.
    ctx.font = '600 11px "Geist Variable", Geist, system-ui, sans-serif'
    const w = ctx.measureText(label).width + 12
    const x = 10
    const y = 8
    ctx.beginPath()
    ctx.roundRect(x, y, w, 18, 9)
    ctx.fillStyle = WRITEY_INK
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, x + 6, y + 9.5)
    ctx.restore()
  }

  // -------------------------------------------------------------------------
  // Load and save
  // -------------------------------------------------------------------------

  async load(): Promise<void> {
    const loaded = await loadPage(this.page.id)
    this.loaded = false
    this.editor.load(loaded.doc)
    this.version = loaded.version
    this.savedRevision = loaded.restored ? -1 : this.editor.revision
    this.loaded = true
    if (loaded.restored) {
      this.cb.onSaveState('dirty')
      this.scheduleSave(0)
    }
  }

  isDirty(): boolean {
    return this.loaded && this.editor.revision !== this.savedRevision
  }

  async flush(): Promise<void> {
    window.clearTimeout(this.saveTimer)
    while (this.saving) await this.saving
    if (!this.isDirty()) return
    const revision = this.editor.revision
    const doc = this.editor.toDoc()
    this.cb.onSaveState('saving')
    this.saving = this.saveOnce(revision, doc).finally(() => {
      this.saving = null
    })
    await this.saving
  }

  private async saveOnce(revision: number, doc: ReturnType<PageEditor['toDoc']>): Promise<void> {
    try {
      const result = await savePage(this.page.id, doc, this.version)
      if (result.ok) {
        this.version = result.version
        this.savedRevision = revision
        if (this.isDirty()) {
          // More edits landed while saving: keep the local copy current and go again.
          void backupPage(this.page.id, this.editor.toDoc(), this.version).catch(() => {})
          this.cb.onSaveState('dirty')
          this.scheduleSave()
        } else {
          void clearBackup(this.page.id).catch(() => {})
          this.cb.onSaveState('saved')
        }
        return
      }
      const keepMine = await ask(
        'This page was changed in another Writey window.\n\n' +
          'Keep yours to overwrite the other version, or load theirs and drop your changes.',
        { ok: 'Keep mine', cancel: 'Load theirs' },
      )
      if (keepMine) {
        this.version = result.conflictVersion
        this.scheduleSave(0)
      } else {
        await this.load()
        this.cb.onSaveState('saved')
      }
    } catch (err) {
      // A deleted page has nothing left to save to.
      if (err instanceof NativeError && err.code === 'not_found') {
        void clearBackup(this.page.id).catch(() => {})
        this.savedRevision = revision
        return
      }
      console.error('page save failed', err)
      this.cb.onSaveState('error')
      this.scheduleSave(RETRY_DELAY_MS)
    }
  }

  private scheduleSave(delay = SAVE_DELAY_MS): void {
    window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => void this.flush(), delay)
  }

  private scheduleBackup(): void {
    window.clearTimeout(this.backupTimer)
    this.backupTimer = window.setTimeout(() => {
      if (this.isDirty()) {
        void backupPage(this.page.id, this.editor.toDoc(), this.version).catch(() => {})
      }
    }, 400)
  }

  private onEditorChange(): void {
    for (const id of this.selection) {
      if (!this.editor.items.some((i) => i.id === id)) this.selection.delete(id)
    }
    this.redrawInk()
    this.requestWet()
    this.cb.onHistory()
    if (!this.isDirty()) return
    this.cb.onSaveState('dirty')
    this.scheduleSave()
    this.scheduleBackup()
  }

  // -------------------------------------------------------------------------
  // Canvases
  // -------------------------------------------------------------------------

  attach(bg: HTMLCanvasElement, ink: HTMLCanvasElement, wet: HTMLCanvasElement): void {
    this.bg = bg
    this.ink = ink
    this.wet = wet
    // No `desynchronized` context: on some Windows GPUs it shows the whole page black.
    // If the GPU drops the canvases anyway, Chrome restores them blank, so draw everything again.
    for (const c of [bg, ink, wet]) c.addEventListener('contextrestored', this.onRestored)
  }

  private onRestored = (): void => {
    if (this.bg) this.layout(this.scale)
  }

  detach(): void {
    for (const c of [this.bg, this.ink, this.wet]) {
      c?.removeEventListener('contextrestored', this.onRestored)
    }
    this.cancelBackground?.()
    this.cancelBackground = null
    cancelAnimationFrame(this.wetFrame)
    this.wetFrame = 0
    this.bg = this.ink = this.wet = null
  }

  layout(scale: number): void {
    this.scale = scale
    const cssW = this.page.width * scale
    const cssH = this.page.height * scale
    this.ratio = Math.min(
      window.devicePixelRatio || 1,
      Math.sqrt(MAX_CANVAS_PIXELS / (cssW * cssH)),
    )
    for (const c of [this.bg, this.ink, this.wet]) {
      if (!c) continue
      c.width = Math.round(cssW * this.ratio)
      c.height = Math.round(cssH * this.ratio)
    }
    this.renderBackground()
    this.redrawInk()
    this.drawWet()
  }

  private context(c: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return null
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    const k = this.scale * this.ratio
    ctx.setTransform(k, 0, 0, k, 0, 0)
    return ctx
  }

  private renderBackground(): void {
    this.cancelBackground?.()
    this.cancelBackground = null
    const c = this.bg
    const ctx = this.context(c)
    if (!c || !ctx) return
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, this.page.width, this.page.height)
    const bg = this.page.background
    if (bg.kind === 'pdf') {
      this.cancelBackground = renderPdfPage(c, bg.assetId, bg.pdfPage, this.scale * this.ratio)
    } else if (bg.kind === 'image') {
      let live = true
      this.cancelBackground = () => {
        live = false
      }
      loadImage(bg.assetId)
        .then((img) => {
          if (live) this.context(c)?.drawImage(img, 0, 0, this.page.width, this.page.height)
        })
        .catch(console.error)
    }
  }

  private image = (assetId: string): HTMLImageElement | null => {
    if (this.images.has(assetId)) return this.images.get(assetId) ?? null
    this.images.set(assetId, null)
    loadImage(assetId)
      .then((img) => {
        this.images.set(assetId, img)
        this.redrawInk()
        this.requestWet()
      })
      .catch(console.error)
    return null
  }

  private redrawInk(): void {
    const ctx = this.context(this.ink)
    const g = this.gesture
    const items = g?.type === 'erase' ? g.items : this.editor.items
    if (ctx) drawItems(ctx, items, { images: this.image, skip: this.hidden })
  }

  private requestWet(): void {
    if (this.wetFrame) return
    this.wetFrame = requestAnimationFrame(() => {
      this.wetFrame = 0
      this.drawWet()
    })
  }

  private drawWet(): void {
    const ctx = this.context(this.wet)
    if (!ctx) return
    if (this.drawGhost(ctx)) this.requestWet()
    const g = this.gesture
    if (g?.type === 'draw') {
      drawStroke(ctx, g.live, { live: true })
      this.drawTip(ctx, g.live)
    }
    if (this.hover) this.drawEraserRing(ctx, this.hover[0], this.hover[1], g?.type === 'erase')
    if (g?.type === 'lasso' && g.poly.length >= 4) {
      ctx.save()
      ctx.beginPath()
      ctx.moveTo(g.poly[0] as number, g.poly[1] as number)
      for (let i = 2; i < g.poly.length; i += 2) {
        ctx.lineTo(g.poly[i] as number, g.poly[i + 1] as number)
      }
      ctx.closePath()
      ctx.fillStyle = 'rgba(47, 75, 240, 0.06)'
      ctx.fill()
      ctx.setLineDash([4 / this.scale, 4 / this.scale])
      ctx.lineWidth = 1 / this.scale
      ctx.strokeStyle = SELECTION_COLOR
      ctx.stroke()
      ctx.restore()
    }
    const selected = this.selectedItems()
    const box = unionBounds(selected)
    if (!box) return
    ctx.save()
    if (g?.type === 'move') ctx.translate(g.dx, g.dy)
    if (g?.type === 'scale') {
      ctx.translate(g.ox, g.oy)
      ctx.scale(g.s, g.s)
      ctx.translate(-g.ox, -g.oy)
    }
    if (g?.type === 'move' || g?.type === 'scale') drawItems(ctx, selected, { images: this.image })
    ctx.restore()
    this.drawSelectionBox(ctx, this.transformedBox(box))
  }

  /** The pen's dot at the end of the live stroke, so you see the tip while the OS hides its cursor. */
  private drawTip(ctx: CanvasRenderingContext2D, live: LiveStroke): void {
    const p = live.points
    const px = 1 / this.scale
    const r = Math.max(3.5 * px, live.width / 2 + 1.5 * px)
    ctx.save()
    ctx.beginPath()
    ctx.arc(p[p.length - 3] as number, p[p.length - 2] as number, r, 0, Math.PI * 2)
    ctx.fillStyle = live.tool === 'pen' ? live.color : 'rgba(29, 28, 25, 0.75)'
    ctx.fill()
    ctx.lineWidth = 1.2 * px
    ctx.strokeStyle = '#fff'
    ctx.stroke()
    ctx.restore()
  }

  private drawEraserRing(ctx: CanvasRenderingContext2D, x: number, y: number, pressed: boolean) {
    const px = 1 / this.scale
    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, (this.tools.eraser.size / 2) * px, 0, Math.PI * 2)
    ctx.fillStyle = pressed ? 'rgba(255, 92, 122, 0.18)' : 'rgba(255, 255, 255, 0.6)'
    ctx.fill()
    ctx.lineWidth = 1.5 * px
    ctx.strokeStyle = pressed ? '#ff5c7a' : 'rgba(22, 23, 29, 0.55)'
    ctx.stroke()
    ctx.restore()
  }

  private transformedBox(b: Rect): Rect {
    const g = this.gesture
    if (g?.type === 'move') return { ...b, x: b.x + g.dx, y: b.y + g.dy }
    if (g?.type === 'scale') {
      return {
        x: g.ox + (b.x - g.ox) * g.s,
        y: g.oy + (b.y - g.oy) * g.s,
        w: b.w * g.s,
        h: b.h * g.s,
      }
    }
    return b
  }

  private drawSelectionBox(ctx: CanvasRenderingContext2D, b: Rect): void {
    const px = 1 / this.scale
    const pad = 4 * px
    ctx.save()
    ctx.strokeStyle = SELECTION_COLOR
    ctx.lineWidth = px
    ctx.setLineDash([5 * px, 4 * px])
    ctx.strokeRect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad)
    ctx.setLineDash([])
    const hs = HANDLE_PX * px
    ctx.fillStyle = '#fff'
    ctx.fillRect(b.x + b.w + pad - hs / 2, b.y + b.h + pad - hs / 2, hs, hs)
    ctx.strokeRect(b.x + b.w + pad - hs / 2, b.y + b.h + pad - hs / 2, hs, hs)
    ctx.restore()
  }

  // -------------------------------------------------------------------------
  // Pointer input
  // -------------------------------------------------------------------------

  private toPage(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.wet?.getBoundingClientRect()
    if (!r) return [0, 0]
    return [(e.clientX - r.left) / this.scale, (e.clientY - r.top) / this.scale]
  }

  pointerDown(e: PointerEvent): void {
    // Touch is ignored so a resting palm never draws.
    if (e.pointerType === 'touch') return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (!this.loaded || !this.wet) return
    this.cb.onActivate()
    try {
      this.wet.setPointerCapture(e.pointerId)
    } catch {
      // Capture is best-effort; the stroke still works without it.
    }
    const [x, y] = this.toPage(e)
    // Pen eraser end (buttons bit 32) erases regardless of the selected tool.
    const tool: ToolId = e.pointerType === 'pen' && e.buttons & 32 ? 'eraser' : this.tools.tool
    if (tool !== 'lasso' && this.selection.size) this.clearSelection()

    switch (tool) {
      case 'pen':
      case 'highlighter': {
        const style = tool === 'pen' ? this.tools.pen : this.tools.highlighter
        this.gesture = {
          type: 'draw',
          live: { tool, color: style.color, width: style.width, points: [x, y, 0] },
          t0: e.timeStamp,
        }
        // The canvas draws the tip while writing; the OS cursor would trail a frame ahead of it.
        this.cursor = this.wet.style.cursor
        this.wet.style.cursor = 'none'
        break
      }
      case 'eraser':
        this.gesture = {
          type: 'erase',
          items: [...this.editor.items],
          origin: new Map(),
          touched: new Set(),
        }
        this.hover = [x, y]
        this.eraseAt(x, y)
        break
      case 'lasso':
        this.lassoDown(x, y)
        break
      case 'text':
        this.beginText(x, y)
        break
    }
    this.requestWet()
  }

  private lassoDown(x: number, y: number): void {
    const b = unionBounds(this.selectedItems())
    if (b) {
      const pad = 4 / this.scale
      const hs = HANDLE_PX / this.scale
      const hx = b.x + b.w + pad
      const hy = b.y + b.h + pad
      if (Math.abs(x - hx) <= hs && Math.abs(y - hy) <= hs) {
        this.gesture = {
          type: 'scale',
          ox: b.x,
          oy: b.y,
          d0: Math.max(1, Math.hypot(x - b.x, y - b.y)),
          s: 1,
        }
        this.hideSelection()
        return
      }
      if (rectContains(b, x, y, pad)) {
        this.gesture = { type: 'move', x0: x, y0: y, dx: 0, dy: 0 }
        this.hideSelection()
        return
      }
      this.clearSelection()
    }
    this.gesture = { type: 'lasso', poly: [x, y] }
  }

  pointerMove(e: PointerEvent): void {
    const g = this.gesture
    const erasing = this.tools.tool === 'eraser' || (e.pointerType === 'pen' && e.buttons & 32)
    if (erasing || g?.type === 'erase') {
      this.hover = this.toPage(e)
      this.requestWet()
    } else if (this.hover) {
      this.hover = null
      this.requestWet()
    }
    if (!g) return
    const coalesced = e.getCoalescedEvents?.()
    const events = coalesced && coalesced.length > 0 ? coalesced : [e]
    for (const ev of events) {
      const [x, y] = this.toPage(ev)
      switch (g.type) {
        case 'draw': {
          const p = g.live.points
          if (p[p.length - 3] === x && p[p.length - 2] === y) break
          p.push(x, y, ev.timeStamp - g.t0)
          break
        }
        case 'erase':
          this.eraseAt(x, y)
          break
        case 'lasso':
          g.poly.push(x, y)
          break
        case 'move':
          g.dx = x - g.x0
          g.dy = y - g.y0
          break
        case 'scale':
          g.s = Math.max(0.1, Math.hypot(x - g.ox, y - g.oy) / g.d0)
          break
      }
    }
    this.requestWet()
  }

  pointerUp(): void {
    const g = this.gesture
    this.gesture = null
    if (g?.type === 'draw' && this.wet) this.wet.style.cursor = this.cursor
    if (!g) return
    switch (g.type) {
      case 'draw': {
        const id = newId()
        this.written.set(id, Date.now())
        this.editor.add([{ kind: 'stroke', id, ...g.live, author: 'user' }])
        break
      }
      case 'erase': {
        const changes = new Map<string, Item[]>()
        for (const id of g.touched) changes.set(id, [])
        for (const item of g.items) {
          const from = g.origin.get(item.id)
          if (!from) continue
          changes.get(from)?.push(item)
          const at = this.written.get(from)
          if (at) this.written.set(item.id, at)
        }
        if (changes.size) this.editor.splice(changes)
        else this.redrawInk()
        break
      }
      case 'lasso': {
        const hits = this.editor.items.filter((i) => itemInLasso(i, g.poly))
        this.selection = new Set(hits.map((i) => i.id))
        this.cb.onHistory()
        break
      }
      case 'move':
        this.hidden.clear()
        if (g.dx || g.dy)
          this.editor.replace(this.selectedItems().map((i) => translateItem(i, g.dx, g.dy)))
        else this.redrawInk()
        break
      case 'scale':
        this.hidden.clear()
        if (g.s !== 1)
          this.editor.replace(this.selectedItems().map((i) => scaleItem(i, g.ox, g.oy, g.s)))
        else this.redrawInk()
        break
    }
    this.requestWet()
  }

  private eraseAt(x: number, y: number): void {
    const g = this.gesture
    if (g?.type !== 'erase') return
    const r = this.tools.eraser.size / 2 / this.scale
    const whole = this.tools.eraser.mode === 'stroke'
    let changed = false
    const next: Item[] = []
    for (const item of g.items) {
      if (this.hidden.has(item.id)) {
        next.push(item)
        continue
      }
      const from = g.origin.get(item.id) ?? item.id
      if (item.kind === 'stroke' && !whole) {
        const pieces = eraseStroke(item, x, y, r, newId)
        if (!pieces) {
          next.push(item)
          continue
        }
        for (const piece of pieces) g.origin.set(piece.id, from)
        next.push(...pieces)
      } else if (!hitItem(item, x, y, r)) {
        next.push(item)
        continue
      }
      // Text and images (and strokes, in whole-stroke mode) go as a whole.
      g.touched.add(from)
      changed = true
    }
    if (!changed) return
    g.items = next
    this.redrawInk()
  }

  /** Hides the eraser ring when the pointer leaves the page. */
  pointerLeave(): void {
    if (!this.hover || this.gesture?.type === 'erase') return
    this.hover = null
    this.requestWet()
  }

  // -------------------------------------------------------------------------
  // Selection, clipboard, keyboard
  // -------------------------------------------------------------------------

  private selectedItems(): Item[] {
    return this.editor.items.filter((i) => this.selection.has(i.id))
  }

  private hideSelection(): void {
    for (const id of this.selection) this.hidden.add(id)
    this.redrawInk()
  }

  private select(ids: Iterable<string>): void {
    this.selection = new Set(ids)
    this.cb.onRequestTool('lasso')
    this.cb.onHistory()
    this.requestWet()
  }

  clearSelection(): void {
    if (this.selection.size === 0) return
    this.selection.clear()
    this.cb.onHistory()
    this.requestWet()
  }

  setTools(tools: ToolState): void {
    if (tools.tool !== 'lasso') this.clearSelection()
    this.tools = tools
  }

  private recolor(color: string): boolean {
    const items = this.selectedItems()
    if (items.length === 0) return false
    this.editor.replace(
      items.map((i) =>
        (i.kind === 'stroke' && i.tool === 'pen') || i.kind === 'text' ? { ...i, color } : i,
      ),
    )
    return true
  }

  private insertImage(asset: AssetRow, width: number, height: number): void {
    const fit = Math.min(1, (this.page.width * 0.6) / width, (this.page.height * 0.6) / height)
    const w = width * fit
    const h = height * fit
    const item: Item = {
      kind: 'image',
      id: newId(),
      assetId: asset.id,
      x: (this.page.width - w) / 2,
      y: (this.page.height - h) / 3,
      w,
      h,
    }
    this.editor.add([item])
    this.select([item.id])
  }

  /** Handles a key press while this page is active. Returns true if it was used. */
  keyDown(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    if (mod && key === 'z') {
      if (e.shiftKey) this.editor.redo()
      else this.editor.undo()
      return true
    }
    if (mod && key === 'y') {
      this.editor.redo()
      return true
    }
    if (mod && (key === 'c' || key === 'x') && this.selection.size) {
      clipboard.items = this.selectedItems()
      if (key === 'x') this.editor.remove(new Set(this.selection))
      return true
    }
    if (mod && key === 'v' && clipboard.items.length) {
      const pasted = clipboard.items.map((i) => translateItem({ ...i, id: newId() }, 16, 16))
      clipboard.items = pasted // repeated pastes cascade
      this.editor.add(pasted)
      this.select(pasted.map((i) => i.id))
      return true
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection.size) {
      this.editor.remove(new Set(this.selection))
      return true
    }
    if (e.key === 'Escape' && this.selection.size) {
      this.clearSelection()
      return true
    }
    if (this.ghost && !this.ghost.writing && !mod) {
      if (e.key === 'Enter') return this.ghostAccept()
      if (e.key === 'Escape') return this.ghostDiscard()
    }
    return false
  }

  // -------------------------------------------------------------------------
  // Text boxes
  // -------------------------------------------------------------------------

  private beginText(x: number, y: number): void {
    const existing = [...this.editor.items]
      .reverse()
      .find((i): i is TextItem => i.kind === 'text' && rectContains(i, x, y))
    if (existing) {
      this.hidden.add(existing.id)
      this.redrawInk()
      this.cb.onTextEdit({ ...existing })
      return
    }
    const size = this.tools.textSize
    this.cb.onTextEdit({
      id: null,
      x,
      y: y - size * 0.65,
      w: Math.max(80, Math.min(320, this.page.width - x - 24)),
      text: '',
      size,
      color: this.tools.pen.color,
    })
  }

  commitText(edit: TextEdit, text: string): void {
    this.cb.onTextEdit(null)
    if (edit.id) this.hidden.delete(edit.id)
    const ctx = this.ink?.getContext('2d')
    if (!text.trim() || !ctx) {
      if (edit.id) this.editor.remove(new Set([edit.id]))
      else this.redrawInk()
      return
    }
    const lines = layoutText(ctx, text, edit.size, edit.w)
    const h = lines.length * edit.size * TEXT_LINE_HEIGHT
    const item: TextItem = {
      kind: 'text',
      id: edit.id ?? newId(),
      x: edit.x,
      y: edit.y,
      w: edit.w,
      h,
      text,
      size: edit.size,
      color: edit.color,
    }
    this.written.set(item.id, Date.now())
    if (edit.id) this.editor.replace([item])
    else this.editor.add([item])
  }
}
