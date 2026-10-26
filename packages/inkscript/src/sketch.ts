import type { Path, Rng } from './layout'

// The diagram pen and the spec readers, shared by diagrams and the physics drawings.

export type Pt = [number, number]

export type DiagramItem = Record<string, unknown> & { kind: string }

export const num = (v: unknown, d: number): number => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : d
}

export const pt = (v: unknown): Pt | null => {
  if (Array.isArray(v) && v.length >= 2) {
    const x = num(v[0], Number.NaN)
    const y = num(v[1], Number.NaN)
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return pt([o.x, o.y])
  }
  return null
}

export const pts = (v: unknown): Pt[] =>
  Array.isArray(v) ? v.map(pt).filter((p): p is Pt => p !== null) : []

export const range = (v: unknown): [number, number] | null => {
  const p = pt(v)
  return p && p[1] !== p[0] ? [Math.min(p[0], p[1]), Math.max(p[0], p[1])] : null
}

export const text = (o: DiagramItem, key = 'label'): string =>
  typeof o[key] === 'string' ? (o[key] as string).trim() : ''

export const center = (o: DiagramItem): Pt | null => pt(o.center) ?? pt(o.at) ?? pt(o.c)

export const deg = (d: number) => (d * Math.PI) / 180

// ---------------------------------------------------------------------------
// The pen (all in points, y down)
// ---------------------------------------------------------------------------

export class Pen {
  readonly paths: Path[] = []
  /** Grid lines and shading, drawn thinner and lighter. */
  readonly light: Path[] = []

  constructor(
    private readonly rng: Rng,
    /** Wobble in points. */
    private readonly rough: number,
  ) {}

  /** Whatever `draw` puts down goes on the light layer. */
  faint(draw: () => void): void {
    const n = this.paths.length
    draw()
    this.light.push(...this.paths.splice(n))
  }

  private j(n = 1): number {
    return (this.rng() - 0.5) * 2 * this.rough * n
  }

  /**
   * A straight stroke: bowed a little, ends a touch off, like a quick ruler-less line.
   * `steady` lines (circuit wires) bow less and land where they should.
   */
  line(a: Pt, b: Pt, dashed = false, steady = false): void {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len < 0.3) return
    if (dashed) {
      const n = Math.max(1, Math.round(len / 7))
      for (let k = 0; k < n; k++) {
        const t0 = k / n
        const t1 = (k + 0.55) / n
        this.line(lerp(a, b, t0), lerp(a, b, t1), false, steady)
      }
      return
    }
    const ux = (b[0] - a[0]) / len
    const uy = (b[1] - a[1]) / len
    const bow = (this.rng() - 0.5) * Math.min(0.025 * len, 3.5) * (steady ? 0.3 : 1)
    const end = steady ? 0.15 : 0.5
    const a2: Pt = [a[0] + this.j(end), a[1] + this.j(end)]
    const b2: Pt = [b[0] + this.j(end), b[1] + this.j(end)]
    const n = Math.max(2, Math.ceil(len / 3))
    const out: number[] = []
    for (let k = 0; k <= n; k++) {
      const t = k / n
      const s = Math.sin(Math.PI * t) * bow
      out.push(a2[0] + (b2[0] - a2[0]) * t - uy * s, a2[1] + (b2[1] - a2[1]) * t + ux * s)
    }
    this.paths.push(out)
  }

  /** A path through points, with a slow sideways wobble. */
  poly(points: readonly Pt[], closed = false, dashed = false): void {
    const ps = closed && points.length > 2 ? [...points, points[0] as Pt] : [...points]
    if (ps.length < 2) return
    if (dashed) {
      for (let i = 0; i + 1 < ps.length; i++) this.line(ps[i] as Pt, ps[i + 1] as Pt, true)
      return
    }
    const out: number[] = []
    const phase = this.rng() * 10
    let dist = 0
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i] as Pt
      if (i > 0) dist += Math.hypot(p[0] - (ps[i - 1] as Pt)[0], p[1] - (ps[i - 1] as Pt)[1])
      const w = Math.sin(dist / 23 + phase) * this.rough * 0.6
      out.push(p[0] + w, p[1] - w * 0.7)
    }
    this.paths.push(out)
  }

  /** A loop that starts at a random angle and runs a little past its start. */
  ellipse(c: Pt, rx: number, ry: number, from = 0, to = Math.PI * 2): void {
    const full = to - from >= Math.PI * 2 - 1e-6
    const start = full ? this.rng() * Math.PI * 2 : from
    const sweep = full ? Math.PI * 2 + 0.25 + this.rng() * 0.3 : to - from
    const n = Math.max(12, Math.ceil((Math.abs(sweep) * Math.max(rx, ry)) / 2.5))
    const phase = this.rng() * 6
    const out: number[] = []
    for (let k = 0; k <= n; k++) {
      const u = k / n
      const t = start + sweep * u
      const wob = 1 + Math.sin(t * 2 + phase) * 0.025 + (full ? u * 0.035 : 0)
      out.push(c[0] + Math.cos(t) * rx * wob, c[1] - Math.sin(t) * ry * wob)
    }
    this.paths.push(out)
  }

  /** Two short strokes meeting at the tip, drawn in one go: wing, tip, wing. */
  head(tip: Pt, from: Pt, size: number): void {
    const a = Math.atan2(tip[1] - from[1], tip[0] - from[0])
    const spread = 0.42 + this.j(0.02)
    const w1: Pt = [tip[0] - Math.cos(a - spread) * size, tip[1] - Math.sin(a - spread) * size]
    const w2: Pt = [tip[0] - Math.cos(a + spread) * size, tip[1] - Math.sin(a + spread) * size]
    this.paths.push([...w1, ...tip, ...w2])
  }

  dot(p: Pt, r: number): void {
    // A tiny tight spiral reads as a filled pen dot.
    const out: number[] = []
    for (let k = 0; k <= 18; k++) {
      const t = (k / 18) * Math.PI * 4
      const rr = r * (1 - k / 22)
      out.push(p[0] + Math.cos(t) * rr, p[1] + Math.sin(t) * rr)
    }
    this.paths.push(out)
  }
}

export const lerp = (a: Pt, b: Pt, t: number): Pt => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
]

/** Catmull-Rom through the points, for freehand curves. */
export function smooth(points: readonly Pt[], closed: boolean, steps = 10): Pt[] {
  const n = points.length
  if (n < 3) return [...points]
  const get = (i: number): Pt =>
    closed ? (points[(i + n) % n] as Pt) : (points[Math.min(n - 1, Math.max(0, i))] as Pt)
  const out: Pt[] = []
  const segs = closed ? n : n - 1
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1)
    const p1 = get(i)
    const p2 = get(i + 1)
    const p3 = get(i + 2)
    for (let s = 0; s < steps; s++) {
      const t = s / steps
      const t2 = t * t
      const t3 = t2 * t
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 *
        (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  out.push(closed ? (points[0] as Pt) : (points[n - 1] as Pt))
  return out
}

/** What a drawing module gets: the pen, the world → page map and the label writer. */
export type Sketch = {
  pen: Pen
  /** World (y up) → page points (y down). Log axes are applied here. */
  map(p: Pt): Pt
  /** Page points → world, the inverse of map. */
  unmap(p: Pt): Pt
  /** The visible world ranges in the model's own units (not logged). */
  xRange: [number, number]
  yRange: [number, number]
  /** Points per world unit. */
  sx: number
  sy: number
  world: { x: [number, number]; y: [number, number] }
  /** Handwriting size in points; symbols scale with it. */
  size: number
  head: number
  label(s: string, at: Pt, dir?: Pt, gap?: number, latex?: boolean): void
  /** Where wires may end (gate and transistor pins); wire ends close to one snap onto it. */
  terminals?: readonly Pt[]
  itemLabel(o: DiagramItem, at: Pt, dir: Pt, gap?: number): void
}

export const dist = (a: Pt, b: Pt): number => Math.hypot(b[0] - a[0], b[1] - a[1])

/** Unit vector from a to b. */
export const unit = (a: Pt, b: Pt): Pt => {
  const d = dist(a, b) || 1
  return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]
}

/** Page-space normal to a → b that points up (or left, for a vertical line). */
export const upNormal = (a: Pt, b: Pt): Pt => {
  const u = unit(a, b)
  const n: Pt = [-u[1], u[0]]
  return n[1] > 1e-9 || (Math.abs(n[1]) <= 1e-9 && n[0] > 0) ? [-n[0], -n[1]] : n
}

/** Samples a quadratic Bézier, for gate outlines and similar curves. */
export function quad(a: Pt, c: Pt, b: Pt, n = 12): Pt[] {
  const out: Pt[] = []
  for (let k = 0; k <= n; k++) {
    const t = k / n
    const m = 1 - t
    out.push([
      m * m * a[0] + 2 * m * t * c[0] + t * t * b[0],
      m * m * a[1] + 2 * m * t * c[1] + t * t * b[1],
    ])
  }
  return out
}
