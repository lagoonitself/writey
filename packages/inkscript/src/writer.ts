import { newId, type Rect } from '@writey/ink-engine'
import { penStrokes, type TimedStroke } from './hand'
import { type Box, handLine, layoutMath, type Path, type Rng, seeded } from './layout'
import { type PlaceEnv, Placer } from './place'
import type { InkBlock, MarkKind } from './script'
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

/** Pause between blocks, ms. */
const BLOCK_PAUSE = 260

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
      case 'text':
        return this.writeBox(
          this.textBox(block.text, block.after),
          block.after,
          block.text,
          block.why,
        )
      case 'math': {
        const latex = block.box ? `\\boxed{${block.latex}}` : block.latex
        return this.writeBox(
          layoutMath(latex, this.rng),
          block.after,
          `$$${block.latex}$$`,
          block.why,
        )
      }
      case 'mark':
        return this.mark(block.kind, block.target, block.note)
      default:
        return null
    }
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

  private pen(
    paths: Path[],
    color: string,
    source: string,
    why: string | undefined,
    rect: Rect,
  ): Written {
    const groupId = newId()
    const { strokes, end } = penStrokes(paths, {
      color,
      width: this.penWidth,
      groupId,
      startAt: this.time,
    })
    this.time = end + BLOCK_PAUSE
    return { groupId, source, why, strokes, rect }
  }

  private mark(kind: MarkKind, target: string, note: string | undefined): WriteResult {
    const line = this.placer.line(target)
    if (!line) return null
    const paths = markPaths(kind, line, this.rng)
    const { size } = this.opts
    if (note) {
      const k = size * 0.72
      const lines = layoutParagraph(note, 14, this.rng)
      const box = stackLines(lines)
      const w = box.w * k
      const h = (box.h + box.d) * k
      const spot = this.placer.beside(line, w + (kind === 'tick' || kind === 'arrow' ? 40 : 0), h)
      if (spot) {
        const x = spot.x + (kind === 'tick' || kind === 'arrow' ? 40 : 0)
        const baseline = spot.y + box.h * k
        paths.push(
          ...box.paths.map((p) => p.map((n, i) => (i % 2 === 0 ? x + n * k : baseline + n * k))),
        )
      }
    }
    this.placer.reserve(line)
    const source = `[${kind} on ${target}]${note ? ` ${note}` : ''}`
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
    case 'arrow': {
      const x = r.x + r.w + 6
      const tail: Path = handLine(x + 34, cy - 12, x, cy, rng)
      const head: Path = [x + 9, cy - 8, x, cy, x + 11, cy + 2]
      return [tail, head]
    }
  }
}
