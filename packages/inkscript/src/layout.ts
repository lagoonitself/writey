import { AXIS, glyph, X_HEIGHT } from './font'
import { type AtomClass, type Delim, type MathNode, parseMath, splitRows } from './latex'

// TeX-like box layout for handwriting (docs §5.5). Everything is in em, y down, with the
// box origin at the left end of its baseline. Paths are listed in writing order.

/** A pen path: flat [x, y, x, y, …]. */
export type Path = number[]

export type Box = { w: number; h: number; d: number; paths: Path[] }

export type Rng = () => number

/** Mulberry32: small, fast and seedable, so the same seed always writes the same way. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Ctx = { s: number; rng: Rng }

const empty = (): Box => ({ w: 0, h: 0, d: 0, paths: [] })

export const shiftPaths = (paths: readonly Path[], dx: number, dy: number): Path[] =>
  paths.map((p) => p.map((n, i) => n + (i % 2 === 0 ? dx : dy)))

/** Lays boxes side by side on one baseline, each after the given gap. */
function hbox(parts: { box: Box; gap?: number; dy?: number }[]): Box {
  const out = empty()
  for (const { box, gap = 0, dy = 0 } of parts) {
    out.w += gap
    out.paths.push(...shiftPaths(box.paths, out.w, dy))
    out.w += box.w
    out.h = Math.max(out.h, box.h - dy)
    out.d = Math.max(out.d, box.d + dy)
  }
  return out
}

/** A hand-drawn straight line: a slight bow and uneven ends. */
export function handLine(x0: number, y0: number, x1: number, y1: number, rng: Rng): Path {
  const len = Math.hypot(x1 - x0, y1 - y0)
  const bow = (rng() - 0.5) * 0.03 * len
  const nx = -(y1 - y0) / (len || 1)
  const ny = (x1 - x0) / (len || 1)
  const n = Math.max(2, Math.ceil(len / 0.08))
  const out: number[] = []
  for (let k = 0; k <= n; k++) {
    const t = k / n
    const b = Math.sin(Math.PI * t) * bow
    out.push(x0 + (x1 - x0) * t + nx * b, y0 + (y1 - y0) * t + ny * b)
  }
  return out
}

/** Per-glyph wobble: a little rotation, size and baseline change, like real handwriting. */
function jitter(paths: readonly Path[], cx: number, rng: Rng, amount = 1): Path[] {
  const r = (rng() - 0.5) * 0.06 * amount
  const k = 1 + (rng() - 0.5) * 0.07 * amount
  const dy = (rng() - 0.5) * 0.035 * amount
  const cos = Math.cos(r) * k
  const sin = Math.sin(r) * k
  return paths.map((p) => {
    const out: number[] = []
    for (let i = 0; i < p.length; i += 2) {
      const x = (p[i] as number) - cx
      const y = p[i + 1] as number
      out.push(cx + x * cos - y * sin, x * sin + y * cos + dy)
    }
    return out
  })
}

const scalePaths = (paths: readonly Path[], k: number): Path[] =>
  paths.map((p) => p.map((n) => n * k))

const SIDE = 0.05

/** One symbol in math: spaced by its ink, so cursive lead-ins don't collide. */
function symBox(ch: string, ctx: Ctx, scale = 1): Box {
  const { s, rng } = ctx
  const k = s * scale
  const special = drawnSymbol(ch, k, rng)
  if (special) return special
  const g = glyph(ch)
  if (!g) return textBox(ch, ctx)
  const w = (g.x1 - g.x0 + SIDE * 2) * k
  const paths = shiftPaths(scalePaths(g.strokes, k), (SIDE - g.x0) * k, 0)
  return { w, h: g.h * k, d: g.d * k, paths: jitter(paths, w / 2, rng) }
}

/** Plus, minus and equals are drawn as lines: steadier than the script font's. */
function drawnSymbol(ch: string, k: number, rng: Rng): Box | null {
  const a = -AXIS * k
  const w = 0.62 * k
  const m = 0.08 * k
  switch (ch) {
    case '-':
    case '−':
      return { w, h: AXIS * k, d: 0, paths: [handLine(m, a, w - m, a + 0.01 * k, rng)] }
    case '+':
      return {
        w,
        h: (AXIS + 0.24) * k,
        d: 0,
        paths: [
          handLine(m, a, w - m, a, rng),
          handLine(w / 2, a - 0.24 * k, w / 2 + 0.01 * k, a + 0.24 * k, rng),
        ],
      }
    case '=':
      return {
        w,
        h: (AXIS + 0.1) * k,
        d: 0,
        paths: [
          handLine(m, a - 0.09 * k, w - m, a - 0.09 * k, rng),
          handLine(m, a + 0.09 * k, w - m, a + 0.09 * k, rng),
        ],
      }
  }
  return null
}

/** Joined cursive text, spaced by the font's advance widths. */
export function textBox(text: string, ctx: Ctx): Box {
  const { s, rng } = ctx
  const out = empty()
  let x = 0
  for (const ch of text) {
    if (ch === ' ') {
      x += 0.32 * s
      continue
    }
    const g = glyph(ch) ?? glyph('?')
    if (!g) continue
    // Glyphs with no lead-in (Greek, symbols) need a little room on both sides.
    const lead = g.x0 >= 0 ? 0.02 * s : 0
    const paths = jitter(
      shiftPaths(scalePaths(g.strokes, s), x + lead, 0),
      x + (g.w * s) / 2,
      rng,
      0.7,
    )
    out.paths.push(...paths)
    out.h = Math.max(out.h, g.h * s)
    out.d = Math.max(out.d, g.d * s)
    x += g.w * s + lead * 2
  }
  out.w = x
  return out
}

// ---------------------------------------------------------------------------
// Delimiters, drawn to any height
// ---------------------------------------------------------------------------

function curve(pts: [number, number][], n = 14): Path {
  // Quadratic B-spline through the control points (smooth, passes near them).
  if (pts.length < 3) return pts.flat()
  const out: number[] = [...(pts[0] as [number, number])]
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] as [number, number]
    const p1 = pts[i] as [number, number]
    const p2 = pts[i + 1] as [number, number]
    const a: [number, number] = i === 1 ? p0 : [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2]
    const b: [number, number] =
      i === pts.length - 2 ? p2 : [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2]
    for (let k = 1; k <= n; k++) {
      const t = k / n
      const u = 1 - t
      out.push(
        u * u * a[0] + 2 * u * t * p1[0] + t * t * b[0],
        u * u * a[1] + 2 * u * t * p1[1] + t * t * b[1],
      )
    }
  }
  return out
}

/** A delimiter spanning `top` to `bottom` (y values). Returns its width and paths. */
function delimPaths(
  d: Delim,
  top: number,
  bottom: number,
  s: number,
  rng: Rng,
): { w: number; paths: Path[] } {
  const H = bottom - top
  const mid = (top + bottom) / 2
  const w = Math.min(0.5, 0.26 + H * 0.06) * s
  const m = 0.07 * s
  const j = () => (rng() - 0.5) * 0.02 * s
  // A quadratic's midpoint sits halfway to its control point, so aim past the edge.
  const bulge = 3 * m - w
  switch (d) {
    case '(':
      return {
        w,
        paths: [
          curve([
            [w - m + j(), top],
            [bulge, mid],
            [w - m + j(), bottom],
          ]),
        ],
      }
    case ')':
      return {
        w,
        paths: [
          curve([
            [m + j(), top],
            [w - bulge, mid],
            [m + j(), bottom],
          ]),
        ],
      }
    case '[':
      return { w, paths: [[w - m, top, m + j(), top, m, bottom, w - m, bottom]] }
    case ']':
      return { w, paths: [[m, top, w - m + j(), top, w - m, bottom, m, bottom]] }
    case '{': {
      const q = H / 4
      return {
        w: w + 0.04 * s,
        paths: [
          curve([
            [w, top],
            [m + 0.1 * s, top + 0.02 * H],
            [m + 0.1 * s, top + q],
            [m + 0.08 * s, mid - 0.02 * H],
            [m - 0.04 * s, mid],
            [m + 0.08 * s, mid + 0.02 * H],
            [m + 0.1 * s, bottom - q],
            [m + 0.1 * s, bottom - 0.02 * H],
            [w, bottom],
          ]),
        ],
      }
    }
    case '}': {
      const q = H / 4
      const r = w - m - 0.06 * s
      return {
        w: w + 0.04 * s,
        paths: [
          curve([
            [0.04 * s, top],
            [r, top + 0.02 * H],
            [r, top + q],
            [r + 0.02 * s, mid - 0.02 * H],
            [r + 0.14 * s, mid],
            [r + 0.02 * s, mid + 0.02 * H],
            [r, bottom - q],
            [r, bottom - 0.02 * H],
            [0.04 * s, bottom],
          ]),
        ],
      }
    }
    case '|':
      return { w: 0.22 * s, paths: [handLine(0.11 * s, top, 0.11 * s + j(), bottom, rng)] }
    case '‖':
      return {
        w: 0.34 * s,
        paths: [
          handLine(0.1 * s, top, 0.1 * s + j(), bottom, rng),
          handLine(0.24 * s, top, 0.24 * s + j(), bottom, rng),
        ],
      }
    case '⟨':
      return { w, paths: [[w - m, top, m, mid, w - m, bottom]] }
    case '⟩':
      return { w, paths: [[m, top, w - m, mid, m, bottom]] }
    case '⌊':
      return { w, paths: [[m, top, m, bottom, w - m, bottom]] }
    case '⌋':
      return { w, paths: [[w - m, top, w - m, bottom, m, bottom]] }
    case '⌈':
      return { w, paths: [[w - m, top, m, top, m, bottom]] }
    case '⌉':
      return { w, paths: [[m, top, w - m, top, w - m, bottom]] }
    default:
      return { w: 0, paths: [] }
  }
}

/** Delimiter box covering `inner` (height above / depth below the baseline), centered on the axis. */
function delimBox(d: Delim, h: number, depth: number, s: number, rng: Rng): Box {
  const axis = AXIS * s
  const half = Math.max(h - axis, depth + axis, 0.5 * s) * 1.08
  const top = -axis - half
  const bottom = -axis + half
  const { w, paths } = delimPaths(d, top, bottom, s, rng)
  return { w, h: -top, d: bottom, paths }
}

// ---------------------------------------------------------------------------
// Math layout
// ---------------------------------------------------------------------------

type Laid = { box: Box; cls: AtomClass | null }

const SPACE = { thin: 0.16, med: 0.22, thick: 0.28 }

function spaceBetween(a: AtomClass, b: AtomClass, script: boolean): number {
  if (a === 'bin' || b === 'bin') return script ? 0.04 : SPACE.med
  if (a === 'rel' || b === 'rel') {
    if (a === 'open' || b === 'close' || b === 'punct') return 0
    return script ? 0.06 : SPACE.thick
  }
  if (a === 'punct') return script ? 0 : SPACE.thin
  if (a === 'op' || b === 'op') return a === 'open' || b === 'close' ? 0 : SPACE.thin
  return 0
}

function list(nodes: readonly MathNode[], ctx: Ctx): Box {
  const laid: Laid[] = nodes.map((n) => node(n, ctx))
  // A binary operator with nothing to its left is unary (a leading minus).
  let prev: AtomClass | null = null
  for (const l of laid) {
    if (
      l.cls === 'bin' &&
      (prev === null || ['bin', 'rel', 'open', 'punct', 'op'].includes(prev))
    ) {
      l.cls = 'ord'
    }
    if (l.cls) prev = l.cls
  }
  for (let i = laid.length - 1; i >= 0; i--) {
    const l = laid[i] as Laid
    if (l.cls === 'bin') {
      const next = laid.slice(i + 1).find((x) => x.cls)
      if (!next || ['rel', 'close', 'punct'].includes(next.cls as string)) l.cls = 'ord'
    }
    if (l.cls) break
  }
  const script = ctx.s < 0.9
  const parts: { box: Box; gap: number }[] = []
  let last: AtomClass | null = null
  for (const l of laid) {
    const gap = last && l.cls ? spaceBetween(last, l.cls, script) * ctx.s : 0
    parts.push({ box: l.box, gap })
    if (l.cls) last = l.cls
  }
  return hbox(parts)
}

const smaller = (s: number) => Math.max(0.5, s * 0.72)

function classOf(n: MathNode): AtomClass | null {
  switch (n.t) {
    case 'sym':
      return n.cls
    case 'delim':
      return n.cls
    case 'op':
      return 'op'
    case 'xarrow':
      return 'rel'
    case 'scripts':
      return n.base ? classOf(n.base) : 'ord'
    case 'space':
      return null
    default:
      return 'ord'
  }
}

function node(n: MathNode, ctx: Ctx): Laid {
  const { s, rng } = ctx
  const cls = classOf(n)
  switch (n.t) {
    case 'sym':
      return { box: symBox(n.ch, ctx), cls }
    case 'group':
      return { box: list(n.body, ctx), cls }
    case 'space':
      return { box: { ...empty(), w: n.em * s }, cls }
    case 'text':
      return { box: textBox(n.text, ctx), cls }
    case 'delim': {
      if (n.size > 0) {
        const half = (n.size * s) / 2
        return { box: delimBox(n.d, AXIS * s + half * 0.9, half * 0.9 - AXIS * s, s, rng), cls }
      }
      return { box: delimBox(n.d, 0.66 * s, 0.16 * s, s, rng), cls }
    }
    case 'op':
      return { box: opBox(n, ctx), cls }
    case 'xarrow':
      return { box: xarrowBox(n, ctx), cls: 'rel' }
    case 'scripts':
      return { box: scriptsBox(n, ctx), cls }
    case 'frac':
      return { box: fracBox(n, ctx), cls }
    case 'sqrt':
      return { box: sqrtBox(n, ctx), cls }
    case 'leftright': {
      const body = list(n.body, ctx)
      const l = delimBox(n.left, body.h, body.d, s, rng)
      const r = delimBox(n.right, body.h, body.d, s, rng)
      return {
        box: hbox([{ box: l }, { box: body, gap: 0.04 * s }, { box: r, gap: 0.04 * s }]),
        cls,
      }
    }
    case 'accent':
      return { box: accentBox(n.kind, node(n.body, ctx).box, ctx), cls }
    case 'array':
      return { box: arrayBox(n, ctx), cls }
    case 'boxed': {
      const b = node(n.body, ctx).box
      const p = 0.18 * s
      const x0 = 0
      const x1 = b.w + 2 * p
      const y0 = -b.h - p
      const y1 = b.d + p
      return {
        box: {
          w: x1,
          h: -y0,
          d: y1,
          paths: [
            ...shiftPaths(b.paths, p, 0),
            handLine(x0, y0, x1, y0, rng),
            handLine(x1, y0, x1, y1, rng),
            handLine(x1, y1, x0, y1, rng),
            handLine(x0, y1, x0, y0, rng),
          ],
        },
        cls,
      }
    }
    case 'cancel': {
      const b = node(n.body, ctx).box
      return { box: { ...b, paths: [...b.paths, handLine(0, b.d, b.w, -b.h, rng)] }, cls }
    }
  }
}

function opBox(n: Extract<MathNode, { t: 'op' }>, ctx: Ctx): Box {
  const { s } = ctx
  if (n.name) return textBox(n.name, ctx)
  const ch = n.ch as string
  const big = ch === '∫' || ch === '∮' || ch === '∬' ? 1.25 : 1.4
  const b = symBox(ch, ctx, s < 0.9 ? 1 : big)
  // Center big operators on the math axis.
  const center = (b.d - b.h) / 2
  const dy = -AXIS * s - center
  return { ...b, h: b.h - dy, d: b.d + dy, paths: shiftPaths(b.paths, 0, dy) }
}

/** A reaction arrow as long as its conditions need, with them written above and below. */
function xarrowBox(n: Extract<MathNode, { t: 'xarrow' }>, ctx: Ctx): Box {
  const { s, rng } = ctx
  const small = { ...ctx, s: smaller(s) }
  const above = n.above ? node(n.above, small).box : null
  const below = n.below ? node(n.below, small).box : null
  const pad = 0.25 * s
  const w = Math.max(1.5 * s, (above?.w ?? 0) + pad * 2, (below?.w ?? 0) + pad * 2)
  const a = -AXIS * s
  const head = 0.16 * s
  const m = 0.06 * s
  const paths: Path[] = []
  const right = (y: number, half = false) => {
    paths.push(handLine(m, y, w - m, y, rng))
    paths.push(
      half
        ? [w - m - head * 1.4, y - head, w - m, y]
        : [w - m - head * 1.3, y - head, w - m, y, w - m - head * 1.3, y + head],
    )
  }
  const left = (y: number, half = false) => {
    paths.push(handLine(w - m, y, m, y, rng))
    paths.push(
      half
        ? [m + head * 1.4, y + head, m, y]
        : [m + head * 1.3, y - head, m, y, m + head * 1.3, y + head],
    )
  }
  const g = 0.09 * s
  switch (n.kind) {
    case '->':
      right(a)
      break
    case '<-':
      left(a)
      break
    case '<->':
      paths.push(handLine(m, a, w - m, a, rng))
      paths.push([w - m - head * 1.3, a - head, w - m, a, w - m - head * 1.3, a + head])
      paths.push([m + head * 1.3, a - head, m, a, m + head * 1.3, a + head])
      break
    case '<=>':
      right(a - g, true)
      left(a + g, true)
      break
    case '=':
      paths.push(handLine(m, a - g, w - m, a - g, rng), handLine(m, a + g, w - m, a + g, rng))
      break
  }
  let h = -a + head + g
  let d = 0
  const gap = 0.12 * s
  if (above) {
    const y = a - g - head - gap - above.d
    paths.push(...shiftPaths(above.paths, (w - above.w) / 2, y))
    h = -y + above.h
  }
  if (below) {
    const y = a + g + head + gap + below.h
    paths.push(...shiftPaths(below.paths, (w - below.w) / 2, y))
    d = y + below.d
  }
  return { w, h, d, paths }
}

function scriptsBox(n: Extract<MathNode, { t: 'scripts' }>, ctx: Ctx): Box {
  const { s } = ctx
  const base = n.base ? node(n.base, ctx).box : { ...empty(), h: X_HEIGHT * s }
  const sub = { ...ctx, s: smaller(s) }
  const sup = n.sup ? node(n.sup, sub).box : null
  const below = n.sub ? node(n.sub, sub).box : null

  const op = n.base?.t === 'op' ? n.base : null
  if (op?.limits && s >= 0.9) {
    // lim, ∑ and ∏ put their scripts above and below.
    const w = Math.max(base.w, sup?.w ?? 0, below?.w ?? 0)
    const gap = 0.1 * s
    const paths = shiftPaths(base.paths, (w - base.w) / 2, 0)
    let h = base.h
    let d = base.d
    if (sup) {
      const y = -base.h - gap - sup.d
      paths.push(...shiftPaths(sup.paths, (w - sup.w) / 2, y))
      h = -y + sup.h
    }
    if (below) {
      const y = base.d + gap + below.h
      paths.push(...shiftPaths(below.paths, (w - below.w) / 2, y))
      d = y + below.d
    }
    return { w, h, d, paths }
  }

  const integral = op?.ch === '∫' || op?.ch === '∮' || op?.ch === '∬'
  let up = Math.max(base.h - 0.18 * s, 0.38 * s)
  let down = Math.max(base.d * 0.6, 0.2 * s)
  if (integral) {
    up = base.h - (sup?.h ?? 0) * 0.6
    down = base.d - (below?.d ?? 0) * 0.3
  }
  if (sup && below) {
    const clash = up - sup.d - (below.h - down)
    if (clash < 0.12 * s) down += 0.12 * s - clash
  }
  const out: Box = { w: base.w, h: base.h, d: base.d, paths: [...base.paths] }
  const x = base.w + 0.03 * s
  let w = base.w
  if (sup) {
    const sx = integral ? x : x
    out.paths.push(...shiftPaths(sup.paths, sx, -up))
    out.h = Math.max(out.h, up + sup.h)
    w = Math.max(w, sx + sup.w)
  }
  if (below) {
    const bx = integral ? x - base.w * 0.35 : x
    out.paths.push(...shiftPaths(below.paths, bx, down))
    out.d = Math.max(out.d, down + below.d)
    w = Math.max(w, bx + below.w)
  }
  out.w = w + 0.03 * s
  return out
}

function fracBox(n: Extract<MathNode, { t: 'frac' }>, ctx: Ctx): Box {
  const { s, rng } = ctx
  const inner = { ...ctx, s: s >= 0.9 ? s * 0.88 : smaller(s) }
  const num = node(n.num, inner).box
  const den = node(n.den, inner).box
  const pad = 0.08 * s
  const w = Math.max(num.w, den.w) + pad * 2
  const axis = AXIS * s
  const gap = 0.14 * s
  const numY = -axis - gap - num.d
  const denY = -axis + gap + den.h
  const paths = [
    ...shiftPaths(num.paths, (w - num.w) / 2, numY),
    ...(n.bar ? [handLine(0, -axis, w, -axis + (rng() - 0.5) * 0.03 * s, rng)] : []),
    ...shiftPaths(den.paths, (w - den.w) / 2, denY),
  ]
  return {
    w: w + 0.06 * s,
    h: -numY + num.h,
    d: denY + den.d,
    paths: shiftPaths(paths, 0.03 * s, 0),
  }
}

function sqrtBox(n: Extract<MathNode, { t: 'sqrt' }>, ctx: Ctx): Box {
  const { s, rng } = ctx
  const body = node(n.body, ctx).box
  const top = -Math.max(body.h, X_HEIGHT * s) - 0.14 * s
  const bottom = Math.max(body.d, 0.05 * s) + 0.06 * s
  const H = bottom - top
  const lead = 0.12 * s + H * 0.12
  const x0 = n.index ? 0.32 * s : 0
  // Tick, down stroke, up stroke and roof, in one movement.
  const radical: Path = [
    x0,
    top + H * 0.55,
    x0 + 0.08 * s,
    top + H * 0.5,
    x0 + lead * 0.55,
    bottom,
    x0 + lead,
    top,
    x0 + lead + 0.08 * s + body.w,
    top + (rng() - 0.5) * 0.03 * s,
  ]
  const paths: Path[] = [radical]
  if (n.index) {
    const idx = node(n.index, { ...ctx, s: smaller(s) * 0.85 }).box
    paths.unshift(
      ...shiftPaths(
        idx.paths,
        Math.max(0, x0 + 0.06 * s - idx.w),
        top + H * 0.42 - idx.d - 0.04 * s,
      ),
    )
  }
  paths.push(...shiftPaths(body.paths, x0 + lead + 0.04 * s, 0))
  return { w: x0 + lead + body.w + 0.14 * s, h: -top, d: bottom, paths }
}

function accentBox(kind: string, body: Box, ctx: Ctx): Box {
  const { s, rng } = ctx
  const y = -Math.max(body.h, X_HEIGHT * s) - 0.12 * s
  const w = body.w
  const cx = w / 2
  const paths = [...body.paths]
  let h = -y
  let d = body.d
  switch (kind) {
    case 'vec': {
      const x0 = Math.min(0.08 * s, w * 0.2)
      const x1 = Math.max(w, 0.3 * s)
      paths.push(handLine(x0, y, x1, y, rng), [
        x1 - 0.12 * s,
        y - 0.08 * s,
        x1,
        y,
        x1 - 0.12 * s,
        y + 0.08 * s,
      ])
      h += 0.08 * s
      break
    }
    case 'hat': {
      const hw = Math.min(w * 0.45, 0.22 * s)
      paths.push([cx - hw, y + 0.02 * s, cx, y - 0.12 * s, cx + hw, y + 0.02 * s])
      h += 0.12 * s
      break
    }
    case 'bar':
      paths.push(handLine(0.04 * s, y, Math.max(w, 0.3 * s), y, rng))
      break
    case 'dot':
      paths.push([cx, y - 0.02 * s, cx + 0.025 * s, y])
      break
    case 'ddot':
      paths.push(
        [cx - 0.1 * s, y - 0.02 * s, cx - 0.075 * s, y],
        [cx + 0.1 * s, y - 0.02 * s, cx + 0.125 * s, y],
      )
      break
    case 'tilde': {
      const tw = Math.min(w * 0.5, 0.25 * s)
      paths.push(
        curve([
          [cx - tw, y + 0.02 * s],
          [cx - tw / 2, y - 0.1 * s],
          [cx + tw / 2, y + 0.08 * s],
          [cx + tw, y - 0.04 * s],
        ]),
      )
      h += 0.06 * s
      break
    }
    case 'underline': {
      const uy = body.d + 0.1 * s
      paths.push(handLine(0, uy, w, uy, rng))
      h = body.h
      d = uy + 0.04 * s
      break
    }
  }
  return { w: Math.max(w, kind === 'vec' ? 0.3 * s : w), h, d, paths }
}

function arrayBox(n: Extract<MathNode, { t: 'array' }>, ctx: Ctx): Box {
  const { s, rng } = ctx
  const cells = n.rows.map((row) => row.map((c) => node(c, ctx).box))
  const cols = Math.max(0, ...cells.map((r) => r.length))
  const aligned = n.align[0] === 'r' && n.align[1] === 'l'
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(0, ...cells.map((r) => r[c]?.w ?? 0)),
  )
  const colGap = (c: number) => {
    if (c === 0) return 0
    if (aligned) return c % 2 === 1 ? 0.12 * s : 0.9 * s
    return n.left === '{' && n.right === '.' ? 0.6 * s : 0.7 * s
  }
  const rowGap = 0.3 * s
  const paths: Path[] = []
  let y = 0
  let first = true
  let firstH = 0
  for (const row of cells) {
    const rh = Math.max(0.6 * s, ...row.map((b) => b.h))
    const rd = Math.max(0.2 * s, ...row.map((b) => b.d))
    if (first) {
      firstH = rh
      first = false
    } else y += rh
    let x = 0
    row.forEach((b, c) => {
      x += colGap(c)
      const cw = widths[c] as number
      const align = n.align[c] ?? 'c'
      const dx = align === 'l' ? 0 : align === 'r' ? cw - b.w : (cw - b.w) / 2
      paths.push(...shiftPaths(b.paths, x + dx, y))
      x += cw
    })
    y += rd + rowGap
  }
  y -= rowGap
  const totalW = widths.reduce((a, w, c) => a + w + colGap(c), 0)
  // Center the block on the math axis.
  const height = firstH + y
  const shift = -AXIS * s - height / 2 + firstH
  const inner: Box = {
    w: totalW,
    h: firstH - shift,
    d: y + shift,
    paths: shiftPaths(paths, 0, shift),
  }
  if (n.left === '.' && n.right === '.') return inner
  const l = delimBox(n.left, inner.h, inner.d, s, rng)
  const r = delimBox(n.right, inner.h, inner.d, s, rng)
  return hbox([{ box: l }, { box: inner, gap: 0.1 * s }, { box: r, gap: 0.1 * s }])
}

/** Lays out one formula (possibly several rows joined by `\\`) at 1 em = 1. */
export function layoutMath(latex: string, rng: Rng): Box {
  const rows = splitRows(latex).map((r) => list([parseMath(r)], { s: 1, rng }))
  if (rows.length <= 1) return rows[0] ?? empty()
  const out = empty()
  let y = 0
  rows.forEach((r, i) => {
    if (i > 0) y += r.h
    out.paths.push(...shiftPaths(r.paths, 0, y))
    out.w = Math.max(out.w, r.w)
    if (i === 0) out.h = r.h
    y += r.d + 0.45
  })
  out.d = y - 0.45
  return out
}

/** Lays out inline math inside a sentence. */
export const inlineMath = (latex: string, rng: Rng): Box => list([parseMath(latex)], { s: 1, rng })

export const writeText = (text: string, rng: Rng): Box => textBox(text, { s: 1, rng })
