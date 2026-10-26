import type { Rect } from '@writey/ink-engine'

// Where AI ink goes on the page (docs §5.4): below the line it continues, in the same
// column, in the first band of free space. Units are page points.

export type LineRef = { label: string; rect: Rect }

export type PlaceEnv = {
  page: { width: number; height: number }
  /** The labeled lines the model saw (L1, L2, …). */
  lines: readonly LineRef[]
  /** Everything already on the page: ink, text, images, PDF text. */
  obstacles: readonly Rect[]
  /** The line the request is about, from the PLAN call. */
  target: string | null
}

const MARGIN = { left: 36, right: 24, top: 40, bottom: 28 }
const CLEAR = 2

const bottom = (r: Rect) => r.y + r.h
const right = (r: Rect) => r.x + r.w
const hits = (a: Rect, b: Rect) =>
  a.x < right(b) + CLEAR &&
  b.x < right(a) + CLEAR &&
  a.y < bottom(b) + CLEAR &&
  b.y < bottom(a) + CLEAR

export class Placer {
  private readonly taken: Rect[]
  private prev: Rect | null = null

  constructor(private readonly env: PlaceEnv) {
    this.taken = [...env.obstacles]
  }

  line(label: string): Rect | null {
    return this.env.lines.find((l) => l.label === label)?.rect ?? null
  }

  /** What a block without its own `after` follows. */
  private anchor(after: string | undefined): Rect | null {
    if (after && after !== 'prev') return this.line(after) ?? this.prev ?? this.defaultAnchor()
    return this.prev ?? this.defaultAnchor()
  }

  private defaultAnchor(): Rect | null {
    const { target, lines } = this.env
    return (target && this.line(target)) || lines.at(-1)?.rect || null
  }

  /** Left edge of the column the anchor sits in: where the student starts their lines. */
  private columnX(anchor: Rect): number {
    if (anchor === this.prev) return anchor.x
    const col = this.env.lines
      .map((l) => l.rect)
      .filter((r) => r.x < right(anchor) && anchor.x < right(r))
    return Math.min(anchor.x, ...col.map((r) => r.x))
  }

  /** Where a block with this `after` would start, for wrapping text to the right width. */
  startX(after: string | undefined): number {
    const anchor = this.anchor(after)
    return anchor ? this.columnX(anchor) : MARGIN.left + 14
  }

  /** Width available to a block starting at `x`. */
  room(x: number): number {
    return this.env.page.width - MARGIN.right - x
  }

  /** First free band at or below `y` for a w × h block at `x`, or null if the page is full. */
  private freeY(x: number, y: number, w: number, h: number): number | null {
    const limit = this.env.page.height - MARGIN.bottom
    let top = Math.max(y, MARGIN.top * 0.5)
    for (let guard = 0; guard < 500; guard++) {
      if (top + h > limit) return null
      const box = { x, y: top, w, h }
      const blocking = this.taken.filter((r) => hits(box, r))
      if (!blocking.length) return top
      top = Math.max(...blocking.map(bottom)) + CLEAR + 1
    }
    return null
  }

  /**
   * Finds room for a block `w` × `h` (points at scale 1) and reserves it. It shrinks to
   * fit the width (down to 60%) and can move to the left margin. Returns its top-left and
   * scale, or null when the page has no room.
   */
  place(
    w: number,
    h: number,
    after: string | undefined,
    gap: number,
  ): { x: number; y: number; scale: number } | null {
    const { page } = this.env
    const anchor = this.anchor(after)
    const startY = anchor ? bottom(anchor) + gap : MARGIN.top
    const xs = anchor ? [this.columnX(anchor), MARGIN.left] : [MARGIN.left + 14]
    for (const x of [...new Set(xs)]) {
      const room = page.width - MARGIN.right - x
      const scale = Math.min(1, room / w)
      if (scale < 0.6) continue
      const y = this.freeY(x, startY, w * scale, h * scale)
      if (y === null) continue
      const rect = { x, y, w: w * scale, h: h * scale }
      this.taken.push(rect)
      this.prev = rect
      return { x, y, scale }
    }
    return null
  }

  /** Reserves a free spot next to a line (for a note), to its right or else just below. */
  beside(line: Rect, w: number, h: number): { x: number; y: number } | null {
    const { page } = this.env
    const x = right(line) + 16
    if (x + w <= page.width - MARGIN.right * 0.5) {
      const y = this.freeY(x, line.y + (line.h - h) / 2, w, h)
      if (y !== null && y < bottom(line) + h) {
        this.taken.push({ x, y, w, h })
        return { x, y }
      }
    }
    return null
  }

  reserve(r: Rect): void {
    this.taken.push(r)
  }
}
