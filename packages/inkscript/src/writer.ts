import { newId, type Rect } from '@writey/ink-engine'
import { drawDiagram } from './diagram'
import { penStrokes, type TimedStroke } from './hand'
import { type Box, handLine, layoutMath, type Path, type Rng, seeded } from './layout'
import { type PlaceEnv, Placer } from './place'
import type { InkBlock, MarkKind, Pin } from './script'
import { drawTable } from './table'
import { layoutParagraph, stackLines } from './text'

// Turns InkScript blocks into timed pen strokes placed on the page (docs §5.4–5.5).

export type WriterOptions = {
  /** Font size in points (1 em). */
  size: number
  color: string
  markColor: string
  seed: number
}

export type Written = {
  groupId: string
  /** What was written, as text with $$LaTeX$$, so the AI can re-read its own ink. */
  source: string
  why?: string
  strokes: TimedStroke[]
  rect: Rect
}

export type WriteResult = Written | { noRoom: true } | null

/** Where Writey's pen goes to read something (a `look` block), in page points. */
export type Look = {
  x: number
  y: number
  rect: Rect
  note?: string
  /** When the pen gets there, ms from the first stroke, and how long it stays. */
  at: number
  dur: number
}

/** Writey's highlighter: the yellow from the toolbar. */
const HIGHLIGHT = '#ffe14a'

/** Pause between blocks, ms. */
const BLOCK_PAUSE = 260
/** How long the pen rests on what it reads, ms. */
const LOOK_MS = 1100

/**
 * Writing size that matches the student's, from their line heights. Allure's small letters
 * are short (0.35 em) next to most people's, so its em runs a little over their line height.
 */
export function sizeFromLines(heights: readonly number[], fallback = 22): number {
  if (!heights.length) return fallback
  const sorted = [...heights].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] as number
  return Math.min(34, Math.max(15, median * 1.15))
}

export class InkWriter {
  readonly placer: Placer
  private readonly rng: Rng
  /** When the next stroke starts, ms from the first. */
  time = 0

  constructor(
    env: PlaceEnv,
    private readonly opts: WriterOptions,
  ) {
    this.placer = new Placer(env)
    this.rng = seeded(opts.seed)
  }

  private get penWidth(): number {
    return Math.min(2.3, Math.max(1.2, this.opts.size * 0.075))
  }

  write(block: InkBlock): WriteResult {
    switch (block.type) {
      case 'text': {
        if (block.pin?.at) {
          const at = this.pinned(block.pin, block.size)
          if (!at) return null
          const width = Math.max(4, this.placer.room(at.x) / at.size)
          const box = stackLines(layoutParagraph(block.text, width, this.rng))
          return this.writeAt(box, at, block.text, block.why)
        }
        return this.writeBox(
          this.textBox(block.text, block.after),
          block.after,
          block.text,
          block.why,
        )
      }
      case 'math': {
        const latex = block.box ? `\\boxed{${block.latex}}` : block.latex
        if (block.pin?.at) {
          const at = this.pinned(block.pin, block.size)
          if (!at) return null
          return this.writeAt(layoutMath(latex, this.rng), at, `$$${block.latex}$$`, block.why)
        }
        return this.writeBox(
          layoutMath(latex, this.rng),
          block.after,
          `$$${block.latex}$$`,
          block.why,
        )
      }
      case 'mark':
        return this.mark(block)
      case 'diagram':
        return this.diagram(block)
      case 'table':
        return this.table(block)
      default:
        return null
    }
  }

  /** Moves the pen to a line or spot to read it; nothing is written. */
  /** Erased ink: its space is free again. */
  free(rect: Rect): void {
    this.placer.free(rect)
  }

  look(block: Extract<InkBlock, { type: 'look' }>): Look | null {
    const rect = this.markRegion(block)
    if (!rect) return null
    // On a line the pen rests just under it, like a finger following the text.
    const y = block.target ? rect.y + rect.h + 2 : rect.y + rect.h / 2
    const at = this.time
    // Longer notes stay up long enough to read.
    const dur = LOOK_MS + Math.min(1200, (block.note?.length ?? 0) * 25)
    this.time += dur + BLOCK_PAUSE
    return { x: rect.x + rect.w / 2, y, rect, note: block.note, at, dur }
  }

  private textBox(text: string, after: string | undefined): Box {
    const { size } = this.opts
    const x = this.placer.startX(after)
    const width = Math.max(8, this.placer.room(x) / size)
    return stackLines(layoutParagraph(text, width, this.rng))
  }

  private writeBox(box: Box, after: string | undefined, source: string, why?: string): WriteResult {
    if (!box.paths.length) return null
    const { size } = this.opts
    const spot = this.placer.place(box.w * size, (box.h + box.d) * size, after, size * 0.35)
    if (!spot) return { noRoom: true }
    const k = size * spot.scale
    const baseline = spot.y + box.h * k
    const paths = box.paths.map((p) =>
      p.map((n, i) => (i % 2 === 0 ? spot.x + n * k : baseline + n * k)),
    )
    return this.pen(paths, this.opts.color, source, why, {
      x: spot.x,
      y: spot.y,
      w: box.w * k,
      h: (box.h + box.d) * k,
    })
  }

  /** Where pinned writing starts (page points) and how big it is. */
  private pinned(
    pin: Pin,
    letters: number | undefined,
  ): { x: number; y: number; size: number } | null {
    if (!pin.at) return null
    const p = this.placer.toPage(pin.img, pin.at[0], pin.at[1])
    if (!p) return null
    // `size` is the height of capital letters in the image; Allure's capitals are ~0.7 em.
    const size = letters
      ? Math.min(40, Math.max(8, (letters * this.placer.pixel(pin.img)) / 0.7))
      : this.opts.size
    return { x: p[0], y: p[1], size }
  }

  /** Writes a box with its left end at `at` and its middle on `at.y`. */
  private writeAt(
    box: Box,
    at: { x: number; y: number; size: number },
    source: string,
    why?: string,
  ): WriteResult {
    if (!box.paths.length) return null
    const k = Math.min(at.size, this.placer.room(at.x) / Math.max(box.w, 0.1))
    const h = (box.h + box.d) * k
    const top = at.y - h / 2
    const baseline = top + box.h * k
    const paths = box.paths.map((p) =>
      p.map((n, i) => (i % 2 === 0 ? at.x + n * k : baseline + n * k)),
    )
    const rect = { x: at.x, y: top, w: box.w * k, h }
    this.placer.pin(rect)
    return this.pen(paths, this.opts.color, source, why, rect, {
      width: Math.min(this.penWidth, Math.max(0.8, k * 0.075)),
    })
  }

  private diagram(block: Extract<InkBlock, { type: 'diagram' }>): WriteResult {
    const { size } = this.opts
    const x = this.placer.startX(block.after)
    const drawn = drawDiagram(block, {
      size,
      maxW: Math.max(size * 5, this.placer.room(x) - size),
      rng: this.rng,
    })
    if (!drawn.paths.length) return null
    const spot = this.placer.place(drawn.w, drawn.h, block.after, size * 0.6)
    if (!spot) return { noRoom: true }
    const paths = drawn.paths.map((p) =>
      p.map((n, i) => (i % 2 === 0 ? spot.x : spot.y) + n * spot.scale),
    )
    const { type: _, why, after: __, ...spec } = block
    const source = `[diagram${block.title ? `: ${block.title}` : ''}] ${JSON.stringify(spec).slice(0, 1500)}`
    return this.pen(
      paths,
      this.opts.color,
      source,
      why,
      { x: spot.x, y: spot.y, w: drawn.w * spot.scale, h: drawn.h * spot.scale },
      { width: this.penWidth * 0.85, speed: 1.6 },
    )
  }

  private table(block: Extract<InkBlock, { type: 'table' }>): WriteResult {
    const t = drawTable(block, this.rng)
    if (!t.paths.length) return null
    // Wide tables write smaller rather than spill off the page.
    const room = this.placer.room(this.placer.startX(block.after))
    const k = Math.max(this.opts.size * 0.6, Math.min(this.opts.size, room / t.w))
    const spot = this.placer.place(t.w * k, t.h * k, block.after, this.opts.size * 0.5)
    if (!spot) return { noRoom: true }
    const s = k * spot.scale
    const paths = t.paths.map((p) => p.map((n, i) => (i % 2 === 0 ? spot.x : spot.y) + n * s))
    const cells = [block.header ?? [], ...block.rows].map((r) => `| ${r.join(' | ')} |`)
    if (block.header?.length) cells.splice(1, 0, `|${' --- |'.repeat(block.header.length)}`)
    const source = `[table${block.title ? `: ${block.title}` : ''}]\n${cells.join('\n')}`
    return this.pen(paths, this.opts.color, source, block.why, {
      x: spot.x,
      y: spot.y,
      w: t.w * s,
      h: t.h * s,
    })
  }

  private pen(
    paths: Path[],
    color: string,
    source: string,
    why: string | undefined,
    rect: Rect,
    style: { width?: number; speed?: number; tool?: 'pen' | 'highlighter' } = {},
  ): Written {
    const groupId = newId()
    const { strokes, end } = penStrokes(paths, {
      color,
      width: style.width ?? this.penWidth,
      groupId,
      startAt: this.time,
      speed: style.speed,
      tool: style.tool,
    })
    this.time = end + BLOCK_PAUSE
    return { groupId, source, why, strokes, rect }
  }

  /** The spot a mark is on: a line, a pointed-at box, or a small square around a point. */
  private markRegion(block: { target?: string; pin?: Pin }): Rect | null {
    if (block.target) return this.placer.line(block.target)
    const pin = block.pin
    if (!pin) return null
    if (pin.box) {
      const a = this.placer.toPage(pin.img, pin.box[0], pin.box[1])
      const b = this.placer.toPage(pin.img, pin.box[2], pin.box[3])
      if (!a || !b) return null
      return { x: a[0], y: a[1], w: Math.max(2, b[0] - a[0]), h: Math.max(2, b[1] - a[1]) }
    }
    if (!pin.at) return null
    const p = this.placer.toPage(pin.img, pin.at[0], pin.at[1])
    if (!p) return null
    const s = this.opts.size * 0.3
    return { x: p[0] - s, y: p[1] - s, w: s * 2, h: s * 2 }
  }

  private mark(block: Extract<InkBlock, { type: 'mark' }>): WriteResult {
    const { kind, note } = block
    const line = this.markRegion(block)
    if (!line) return null
    const where = block.target ?? 'the marked spot'
    const pinned = !block.target
    if (kind === 'highlight') {
      // One highlighter pass along the middle of the line, as wide as the writing is tall.
      const y = line.y + line.h / 2
      const path = handLine(line.x - 2, y, line.x + line.w + 2, y + 0.5, this.rng)
      this.placer.reserve(line)
      return this.pen([path], HIGHLIGHT, `[highlight on ${where}]`, undefined, line, {
        tool: 'highlighter',
        width: Math.min(26, Math.max(8, line.h * 0.9)),
        speed: 2,
      })
    }
    // A pointed-at arrow is drawn from its note to the spot, below.
    const paths = pinned && kind === 'arrow' ? [] : markPaths(kind, line, this.rng)
    const { size } = this.opts
    let tail: [number, number] | null = null
    if (note) {
      const k = size * 0.72
      const lines = layoutParagraph(note, 14, this.rng)
      const box = stackLines(lines)
      const w = box.w * k
      const h = (box.h + box.d) * k
      const shift = !pinned && (kind === 'tick' || kind === 'arrow') ? 40 : 0
      const spot = pinned ? this.placer.near(line, w, h) : this.placer.beside(line, w + shift, h)
      if (spot) {
        const x = spot.x + shift
        const baseline = spot.y + box.h * k
        paths.push(
          ...box.paths.map((p) => p.map((n, i) => (i % 2 === 0 ? x + n * k : baseline + n * k))),
        )
        if (pinned) tail = edgeToward({ x, y: spot.y, w, h }, line)
      }
    }
    if (pinned && (kind === 'arrow' || tail)) {
      // A leader from the note (or from up and to the right) to the spot, arrowed for arrows.
      const from = tail ?? [line.x + line.w + 40, line.y - 30]
      // A point is reached at its centre; a region at its edge.
      const goal = block.pin?.box
        ? line
        : { x: line.x + line.w / 2, y: line.y + line.h / 2, w: 0, h: 0 }
      const to = edgeToward(goal, { x: from[0], y: from[1], w: 0, h: 0 })
      paths.push(handLine(from[0], from[1], to[0], to[1], this.rng))
      if (kind === 'arrow' || kind === 'point') paths.push(arrowHead(from, to))
    }
    this.placer.reserve(line)
    const source = `[${kind} on ${where}]${note ? ` ${note}` : ''}`
    const xs = paths.flatMap((p) => p.filter((_, i) => i % 2 === 0))
    const ys = paths.flatMap((p) => p.filter((_, i) => i % 2 === 1))
    const rect = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    }
    return this.pen(paths, this.opts.markColor, source, undefined, rect)
  }
}

/** The point on the edge of `r` facing the middle of `toward`. */
function edgeToward(r: Rect, toward: Rect): [number, number] {
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const dx = toward.x + toward.w / 2 - cx
  const dy = toward.y + toward.h / 2 - cy
  if (!dx && !dy) return [cx, cy]
  const t = Math.min(
    dx ? r.w / 2 / Math.abs(dx) : Number.POSITIVE_INFINITY,
    dy ? r.h / 2 / Math.abs(dy) : Number.POSITIVE_INFINITY,
  )
  const pad = 3
  const len = Math.hypot(dx, dy)
  return [cx + dx * t + (dx / len) * pad, cy + dy * t + (dy / len) * pad]
}

/** Two short strokes at `to`, pointing away from `from`. */
function arrowHead(from: [number, number], to: [number, number]): Path {
  const a = Math.atan2(to[1] - from[1], to[0] - from[0])
  const l = 9
  return [
    to[0] - l * Math.cos(a - 0.45),
    to[1] - l * Math.sin(a - 0.45),
    to[0],
    to[1],
    to[0] - l * Math.cos(a + 0.45),
    to[1] - l * Math.sin(a + 0.45),
  ]
}

/** A teacher's red-pen marks around a line, in page points. */
export function markPaths(kind: MarkKind, r: Rect, rng: Rng): Path[] {
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const j = (n: number) => (rng() - 0.5) * n
  switch (kind) {
    case 'circle': {
      // A loop that starts top-left and overshoots where it began, like a quick pen circle.
      const rx = r.w / 2 + 8
      const ry = r.h / 2 + 6
      const out: number[] = []
      const start = -Math.PI * 0.62
      const n = 48
      for (let k = 0; k <= n; k++) {
        const t = start + (k / n) * Math.PI * 2.12
        const wob = 1 + Math.sin(t * 3 + rng()) * 0.025 + (k / n) * 0.05
        out.push(cx + Math.cos(t) * rx * wob, cy + Math.sin(t) * ry * wob)
      }
      return [out]
    }
    case 'underline': {
      const y = r.y + r.h + 3
      return [handLine(r.x - 2, y + j(2), r.x + r.w + 2, y + j(2), rng)]
    }
    case 'cross':
      return [
        handLine(r.x - 3, r.y + r.h * 0.2, r.x + r.w + 3, r.y + r.h * 0.8, rng),
        handLine(r.x - 3, r.y + r.h * 0.8, r.x + r.w + 3, r.y + r.h * 0.2, rng),
      ]
    case 'tick': {
      const s = Math.min(18, Math.max(10, r.h * 0.7))
      const x = r.x + r.w + 10
      return [[x, cy, x + s * 0.35, cy + s * 0.4, x + s, cy - s * 0.6]]
    }
    case 'highlight':
      return [handLine(r.x, cy, r.x + r.w, cy, rng)]
    case 'box': {
      const x0 = r.x - 4
      const y0 = r.y - 4
      const x1 = r.x + r.w + 4
      const y1 = r.y + r.h + 4
      return [
        handLine(x0, y0 + j(2), x1, y0 + j(2), rng),
        handLine(x1 + j(2), y0, x1 + j(2), y1, rng),
        handLine(x1, y1 + j(2), x0, y1 + j(2), rng),
        handLine(x0 + j(2), y1, x0 + j(2), y0, rng),
      ]
    }
    case 'point': {
      // A small dot, drawn as a tight spiral so it reads as filled.
      const out: number[] = []
      for (let k = 0; k <= 30; k++) {
        const t = (k / 30) * Math.PI * 6
        const rad = 3.2 * (1 - k / 34)
        out.push(cx + Math.cos(t) * rad, cy + Math.sin(t) * rad)
      }
      return [out]
    }
    case 'arrow': {
      const x = r.x + r.w + 6
      const tail: Path = handLine(x + 34, cy - 12, x, cy, rng)
      const head: Path = [x + 9, cy - 8, x, cy, x + 11, cy + 2]
      return [tail, head]
    }
  }
}
