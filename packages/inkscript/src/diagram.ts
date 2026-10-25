import {
  CIRCUIT_KINDS,
  circuitExtent,
  circuitSegments,
  circuitTerminals,
  drawCircuit,
  junctionDots,
} from './circuit'
import { compile } from './expr'
import { drawField, FIELD_KINDS, fieldExtent } from './fields'
import { calloutRoom, drawFreehand, FREEHAND_KINDS, freehandExtent, type PageBox } from './freehand'
import { type Box, layoutMath, type Path, type Rng } from './layout'
import { drawLogic, LOGIC_KINDS, logicExtent } from './logic'
import { drawOptics, OPTICS_KINDS, opticsExtent } from './optics'
import {
  center,
  type DiagramItem,
  deg,
  lerp,
  num,
  Pen,
  type Pt,
  pt,
  pts,
  range,
  type Sketch,
  smooth,
  text,
} from './sketch'
import { layoutParagraph, stackLines } from './text'

// Diagrams and graphs (docs §5.6). The model never draws pixels: it writes a spec in its own
// math coordinates (y up), and Writey draws it with a pen, rough.js-style: lines bow a
// little, ends wander, circles start anywhere and overshoot where they began.

export type { DiagramItem } from './sketch'

export type DiagramSpec = {
  /** Frame size in points; the height follows the coordinates when left out. */
  w?: number
  h?: number
  /** World ranges, in the model's own units. Fitted to the items when left out. */
  x?: [number, number]
  y?: [number, number]
  /** Coordinates run downward, as in SVG (for freehand pictures drawn with SVG paths). */
  ydown?: boolean
  items: DiagramItem[]
}

/** A drawn diagram in points, top-left at 0,0, y down, paths in drawing order. */
export type DrawnDiagram = { w: number; h: number; paths: Path[] }

const KINDS: Record<string, string> = {
  line: 'line',
  segment: 'line',
  arrow: 'arrow',
  vector: 'arrow',
  force: 'arrow',
  ray: 'arrow',
  polyline: 'polyline',
  path: 'polyline',
  polygon: 'polygon',
  triangle: 'polygon',
  curve: 'curve',
  sketch: 'curve',
  freehand: 'curve',
  spline: 'curve',
  rect: 'rect',
  rectangle: 'rect',
  box: 'rect',
  block: 'rect',
  square: 'rect',
  circle: 'circle',
  ellipse: 'ellipse',
  arc: 'arc',
  angle: 'angle',
  axes: 'axes',
  axis: 'axes',
  plot: 'plot',
  graph: 'plot',
  function: 'plot',
  parametric: 'parametric',
  point: 'point',
  dot: 'point',
  label: 'label',
  text: 'label',
  dimension: 'dimension',
  hatch: 'hatch',
  ground: 'hatch',
  wall: 'hatch',
  surface: 'hatch',
  spring: 'spring',
  pulley: 'pulley',
  wheel: 'pulley',
  ...CIRCUIT_KINDS,
  ...OPTICS_KINDS,
  convex_lens: 'lens',
  concave_lens: 'lens',
  converging_lens: 'lens',
  diverging_lens: 'lens',
  concave_mirror: 'mirror',
  convex_mirror: 'mirror',
  ...FIELD_KINDS,
  ...LOGIC_KINDS,
  ...FREEHAND_KINDS,
}

const CIRCUIT = new Set(Object.values(CIRCUIT_KINDS))
const OPTICS = new Set(['lens', 'mirror', ...Object.values(OPTICS_KINDS)])
const FIELDS = new Set(Object.values(FIELD_KINDS))
const FREEHAND = new Set(Object.values(FREEHAND_KINDS))

/**
 * Accepts both `{"kind":"arrow",…}` (or `type`/`shape`) and the docs' `{"arrow":{…}}`.
 * Unknown shapes are dropped.
 */
export function diagramItems(raw: unknown): DiagramItem[] {
  if (!Array.isArray(raw)) return []
  const out: DiagramItem[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    let name = [o.kind, o.type, o.shape].find((v) => typeof v === 'string') as string | undefined
    let body = o
    if (!name) {
      const keys = Object.keys(o)
      const key = keys.find((k) => k.toLowerCase() in KINDS)
      if (!key) continue
      name = key
      const v = o[key]
      body = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : o
    }
    const kind = KINDS[name.toLowerCase()]
    // An alias keeps what it said as the type: "nand" is a gate of type nand.
    if (kind)
      out.push({
        ...(kind !== name.toLowerCase() ? { type: name.toLowerCase() } : {}),
        ...body,
        kind,
      })
  }
  return out
}

// ---------------------------------------------------------------------------
// Reading the spec
// ---------------------------------------------------------------------------

function rectCorners(o: DiagramItem): Pt[] {
  const w = num(o.w ?? o.width, 1)
  const h = num(o.h ?? o.height, w)
  const c = pt(o.center)
  const at = c ? ([c[0] - w / 2, c[1] - h / 2] as Pt) : (pt(o.at) ?? pt(o.from) ?? [0, 0])
  const a = deg(num(o.angle ?? o.rotate, 0))
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  // Rotated about the lower-left corner, so a block can sit on an incline.
  return (
    [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ] as Pt[]
  ).map(([x, y]) => [at[0] + x * cos - y * sin, at[1] + x * sin + y * cos] as Pt)
}

/** The plotted function's domain: its own, else the spec's or the axes' x range. */
function domain(o: DiagramItem, fallback: [number, number]): [number, number] {
  return range(o.domain) ?? range(o.x) ?? fallback
}

const plotFn = (o: DiagramItem) => {
  const src = [o.expr, o.fn, o.y, o.f].find((v) => typeof v === 'string') as string | undefined
  if (!src) return null
  const f = compile(src.replace(/^\s*(y|f\(x\))\s*=/, ''), ['x'])
  return (x: number) => f({ x })
}

function sample(f: (x: number) => number, [a, b]: [number, number], n = 240): Pt[] {
  const out: Pt[] = []
  for (let k = 0; k <= n; k++) {
    const x = a + ((b - a) * k) / n
    out.push([x, f(x)])
  }
  return out
}

function paramPoints(o: DiagramItem): Pt[] {
  if (typeof o.x !== 'string' || typeof o.y !== 'string') return []
  const fx = compile(o.x, ['t'])
  const fy = compile(o.y, ['t'])
  const [a, b] = range(o.t ?? o.domain) ?? [0, Math.PI * 2]
  const out: Pt[] = []
  for (let k = 0; k <= 240; k++) {
    const t = a + ((b - a) * k) / 240
    out.push([fx({ t }), fy({ t })])
  }
  return out
}

/** Points that bound an item, for fitting the world to the drawing. */
function extent(o: DiagramItem, xr: [number, number] | null): Pt[] {
  switch (o.kind) {
    case 'line':
    case 'arrow':
    case 'dimension':
    case 'hatch':
    case 'spring':
      return [pt(o.from), pt(o.to)].filter((p): p is Pt => p !== null)
    case 'polyline':
    case 'polygon':
    case 'curve':
      return pts(o.points)
    case 'rect':
      return rectCorners(o)
    case 'circle':
    case 'pulley':
    case 'arc':
    case 'ellipse': {
      const c = center(o)
      if (!c) return []
      const rx = num(o.rx ?? o.r ?? o.radius, 1)
      const ry = num(o.ry ?? o.r ?? o.radius, rx)
      return [
        [c[0] - rx, c[1] - ry],
        [c[0] + rx, c[1] + ry],
      ]
    }
    case 'angle':
      return [pt(o.vertex)].filter((p): p is Pt => p !== null)
    case 'axes': {
      const x = range(o.x)
      const y = range(o.y)
      return x && y
        ? [
            [x[0], y[0]],
            [x[1], y[1]],
          ]
        : []
    }
    case 'plot': {
      const f = plotFn(o)
      if (!f) return []
      const ys = sample(f, domain(o, xr ?? [-5, 5]), 120)
        .map((p) => p[1])
        .filter(Number.isFinite)
        .sort((a, b) => a - b)
      if (!ys.length) return []
      // Ignore the far tails, so 1/x doesn't squash the whole graph.
      const lo = ys[Math.floor(ys.length * 0.04)] as number
      const hi = ys[Math.ceil(ys.length * 0.96) - 1] as number
      const [a, b] = domain(o, xr ?? [-5, 5])
      return [
        [a, lo],
        [b, hi],
      ]
    }
    case 'parametric':
      return paramPoints(o).filter((p) => p.every(Number.isFinite))
    case 'point':
    case 'label':
      return [pt(o.at) ?? pt(o.pos)].filter((p): p is Pt => p !== null)
    default:
      if (CIRCUIT.has(o.kind)) return circuitExtent(o)
      if (OPTICS.has(o.kind)) return opticsExtent(o)
      if (FIELDS.has(o.kind)) return fieldExtent(o)
      if (o.kind === 'logic') return logicExtent(o)
      if (FREEHAND.has(o.kind)) return freehandExtent(o)
      return []
  }
}

/** The world box, in y-up units (a y-down spec's y values are negated). */
function fitWorld(spec: DiagramSpec): { x: [number, number]; y: [number, number] } {
  const fy = spec.ydown ? -1 : 1
  const axes = spec.items.find((o) => o.kind === 'axes')
  const xr = range(spec.x) ?? (axes && range(axes.x))
  const y0 = range(spec.y) ?? (axes && range(axes.y))
  const yr: [number, number] | null | undefined = y0 && (fy > 0 ? y0 : [-y0[1], -y0[0]])
  if (xr && yr) return { x: xr, y: yr }
  const all = spec.items.flatMap((o) => extent(o, xr ?? null)).map((p): Pt => [p[0], fy * p[1]])
  const xs = all.map((p) => p[0])
  const ys = all.map((p) => p[1])
  const pad = (lo: number, hi: number): [number, number] => {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [-1, 1]
    if (hi - lo < 1e-9) return [lo - 1, hi + 1]
    const m = (hi - lo) * 0.08
    return [lo - m, hi + m]
  }
  return {
    x: xr ?? pad(Math.min(...xs), Math.max(...xs)),
    y: yr ?? pad(Math.min(...ys), Math.max(...ys)),
  }
}

function niceStep(span: number, target = 6): number {
  const raw = span / target
  const p = 10 ** Math.floor(Math.log10(raw))
  const m = raw / p
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p
}

const fmt = (v: number): string => {
  const r = Math.round(v * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

export type DiagramOptions = {
  /** Handwriting size in points (1 em); labels and arrowheads follow it. */
  size: number
  /** Widest the frame may be, in points. */
  maxW: number
  rng: Rng
}

export function drawDiagram(spec: DiagramSpec, opts: DiagramOptions): DrawnDiagram {
  const { size, rng } = opts
  const world = fitWorld(spec)
  const xr = world.x[1] - world.x[0]
  const yr = world.y[1] - world.y[0]
  // Circuits get a fixed scale (a gate is about two letters' height across), so a big
  // circuit gets a big drawing instead of being squeezed into the default width.
  const wired = spec.items.some((o) => CIRCUIT.has(o.kind) || o.kind === 'logic')
  const rayItems = spec.items.filter(
    (o) => o.kind === 'optics' || o.kind === 'lens' || o.kind === 'mirror',
  )
  const instrument = rayItems.some((o) => Array.isArray(o.elements) && o.elements.length > 1)
  const natural = wired
    ? Math.max(230, xr * size * 1.25)
    : instrument
      ? opts.maxW
      : rayItems.length
        ? Math.max(300, size * 14)
        : spec.items.some((o) => FREEHAND.has(o.kind))
          ? opts.maxW
          : Math.max(230, size * 11)
  // Callout names sit beside the drawing, so the drawing leaves them room.
  const room = calloutRoom(spec.items, { size }, (world.x[0] + world.x[1]) / 2)
  const W = Math.min(
    Math.max(size * 6, opts.maxW - room.left - room.right),
    Math.max(size * 4, num(spec.w, natural)),
  )
  // Same scale on both axes unless told otherwise, so circles stay round.
  // Ray diagrams stretch their heights, as textbooks do, so rays don't lie flat on the axis.
  const rays = spec.items.some(
    (o) => o.kind === 'optics' || o.kind === 'lens' || o.kind === 'mirror',
  )
  const minH = W * (rays ? 0.62 : 0.4)
  const natH = Math.min(W * 1.15, Math.max(minH, (W * yr) / xr))
  // A ray diagram is never squashed flat, even when asked for a short frame.
  const H = Math.max(size * 3, rays ? Math.max(num(spec.h, natH), minH) : num(spec.h, natH))
  const sx = W / xr
  const sy = H / yr
  const fy = spec.ydown ? -1 : 1
  const map = (p: Pt): Pt => [(p[0] - world.x[0]) * sx, H - (fy * p[1] - world.y[0]) * sy]
  const pen = new Pen(rng, Math.max(0.35, size * 0.03))
  const headSize = Math.max(4, size * 0.32)
  const labelK = size * 0.62

  /** Writes a label so its box sits on the side `dir` points to (y down), `gap` off the anchor. */
  const label = (s: string, at: Pt, dir: Pt = [0, 0], gap = 3, latex = false): void => {
    if (!s) return
    const box: Box = latex ? layoutMath(s, rng) : stackLines(layoutParagraph(s, 14, rng))
    const bw = box.w * labelK
    const bh = (box.h + box.d) * labelK
    const cx = at[0] + dir[0] * (bw / 2 + gap)
    const cy = at[1] + dir[1] * (bh / 2 + gap)
    const x = cx - bw / 2
    const base = cy - bh / 2 + box.h * labelK
    for (const p of box.paths) {
      pen.paths.push(p.map((n, i) => (i % 2 === 0 ? x + n * labelK : base + n * labelK)))
    }
  }

  const itemLabel = (o: DiagramItem, at: Pt, dir: Pt, gap = 3) => {
    const l = text(o)
    if (l) label(l, at, dir, gap)
    else if (text(o, 'latex')) label(text(o, 'latex'), at, dir, gap, true)
  }

  /** Unit normal (y down) to the left of a → b on screen. */
  const normal = (a: Pt, b: Pt): Pt => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    return [(b[1] - a[1]) / len, -(b[0] - a[0]) / len]
  }

  // The drawing's own box on the page (without callout names), for placing those names.
  const drawn = spec.items
    .filter((o) => o.kind !== 'callouts')
    .flatMap((o) => extent(o, world.x))
    .map(map)
  const content: PageBox = drawn.length
    ? {
        L: Math.min(...drawn.map((p) => p[0])),
        R: Math.max(...drawn.map((p) => p[0])),
        T: Math.min(...drawn.map((p) => p[1])),
        B: Math.max(...drawn.map((p) => p[1])),
      }
    : { L: 0, R: W, T: 0, B: H }
  const terminals = circuitTerminals(spec.items)
  const sketch: Sketch = {
    pen,
    map,
    sx,
    sy,
    world,
    size,
    head: headSize,
    label,
    itemLabel,
    terminals,
  }

  const yMin = world.y[0] - yr * 0.02
  const yMax = world.y[1] + yr * 0.02
  /** World points → screen runs, broken where the curve leaves the frame or blows up. */
  const runs = (points: readonly Pt[]): Pt[][] => {
    const out: Pt[][] = []
    let run: Pt[] = []
    const inside = (p: Pt) => Number.isFinite(p[1]) && p[1] >= yMin && p[1] <= yMax
    for (let i = 0; i < points.length; i++) {
      const p = points[i] as Pt
      const prev = points[i - 1]
      if (inside(p)) {
        if (!run.length && prev && Number.isFinite(prev[1])) {
          const edge = prev[1] > yMax ? yMax : yMin
          const t = (edge - prev[1]) / (p[1] - prev[1])
          if (t > 0 && t < 1) run.push(map([prev[0] + (p[0] - prev[0]) * t, edge]))
        }
        run.push(map(p))
      } else {
        if (run.length && prev && Number.isFinite(p[1]) && inside(prev)) {
          const edge = p[1] > yMax ? yMax : yMin
          const t = (edge - prev[1]) / (p[1] - prev[1])
          run.push(map([prev[0] + (p[0] - prev[0]) * t, edge]))
        }
        if (run.length > 1) out.push(run)
        run = []
      }
    }
    if (run.length > 1) out.push(run)
    return out
  }

  for (const o of spec.items) {
    const dashed = o.dashed === true || o.style === 'dashed'
    switch (o.kind) {
      case 'line': {
        const a = pt(o.from)
        const b = pt(o.to)
        if (!a || !b) break
        pen.line(map(a), map(b), dashed)
        itemLabel(o, lerp(map(a), map(b), 0.5), normal(map(a), map(b)))
        break
      }
      case 'arrow': {
        const a = pt(o.from) ?? pt(o.at)
        const b = pt(o.to)
        if (!a || !b) break
        const [p, q] = [map(a), map(b)]
        pen.line(p, q, dashed)
        pen.head(q, p, headSize)
        if (o.both === true || o.double === true) pen.head(p, q, headSize)
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1
        itemLabel(o, q, [(q[0] - p[0]) / len, (q[1] - p[1]) / len], 2)
        break
      }
      case 'polyline':
      case 'polygon': {
        const ps = pts(o.points).map(map)
        pen.poly(ps, o.kind === 'polygon' || o.closed === true, dashed)
        if (ps.length) {
          const c: Pt = [
            ps.reduce((s, p) => s + p[0], 0) / ps.length,
            ps.reduce((s, p) => s + p[1], 0) / ps.length,
          ]
          itemLabel(o, c, [0, 0])
        }
        break
      }
      case 'curve': {
        const closed = o.closed === true
        const ps = smooth(pts(o.points), closed).map(map)
        pen.poly(ps, false, dashed)
        const end = ps.at(-1)
        if (end) itemLabel(o, end, [0.7, -0.7])
        break
      }
      case 'rect': {
        const cs = rectCorners(o).map(map)
        // Four strokes, like a box drawn by hand, each corner slightly crossed.
        for (let i = 0; i < 4; i++) {
          const a = cs[i] as Pt
          const b = cs[(i + 1) % 4] as Pt
          pen.line(lerp(a, b, -0.03), lerp(a, b, 1.03), dashed)
        }
        const c = lerp(cs[0] as Pt, cs[2] as Pt, 0.5)
        itemLabel(o, c, [0, 0])
        break
      }
      case 'circle':
      case 'ellipse':
      case 'pulley': {
        const c = center(o)
        if (!c) break
        const rx = Math.abs(num(o.rx ?? o.r ?? o.radius, 1) * sx)
        const ry = o.kind === 'ellipse' ? Math.abs(num(o.ry ?? o.r, 1) * sy) : rx
        pen.ellipse(map(c), rx, ry)
        if (o.kind === 'pulley') pen.dot(map(c), Math.max(1.2, rx * 0.12))
        itemLabel(
          o,
          map(c),
          o.kind === 'pulley' ? [0.7, -0.7] : [0, 0],
          o.kind === 'pulley' ? rx : 0,
        )
        break
      }
      case 'arc': {
        const c = center(o)
        if (!c) break
        const r = Math.abs(num(o.r ?? o.radius, 1) * sx)
        const a0 = deg(num(o.from ?? o.start, 0))
        const a1 = deg(num(o.to ?? o.end, 90))
        pen.ellipse(map(c), r, r, a0, a1)
        const mid = (a0 + a1) / 2
        itemLabel(o, map(c), [Math.cos(mid), -Math.sin(mid)], r + 2)
        break
      }
      case 'angle': {
        const v = pt(o.vertex) ?? pt(o.at)
        const a = pt(o.from)
        const b = pt(o.to)
        if (!v || !a || !b) break
        const a0 = Math.atan2(a[1] - v[1], (a[0] - v[0]) * (sx / sy))
        let a1 = Math.atan2(b[1] - v[1], (b[0] - v[0]) * (sx / sy))
        while (a1 < a0) a1 += Math.PI * 2
        // The short way round.
        const [s, e] = a1 - a0 > Math.PI ? [a1, a0 + Math.PI * 2] : [a0, a1]
        const r = num(o.r, 0) ? num(o.r, 0) * sx : Math.max(size * 0.9, Math.min(W, H) * 0.09)
        if (o.right === true) {
          const k = r * 0.7
          const u: Pt = [Math.cos(s) * k, -Math.sin(s) * k]
          const w: Pt = [Math.cos(e) * k, -Math.sin(e) * k]
          const m = map(v)
          pen.poly([
            [m[0] + u[0], m[1] + u[1]],
            [m[0] + u[0] + w[0], m[1] + u[1] + w[1]],
            [m[0] + w[0], m[1] + w[1]],
          ])
        } else pen.ellipse(map(v), r, r, s, e)
        const mid = (s + e) / 2
        itemLabel(o, map(v), [Math.cos(mid), -Math.sin(mid)], r + 2)
        break
      }
      case 'axes': {
        const x = range(o.x) ?? world.x
        const y = range(o.y) ?? world.y
        const ox = Math.min(Math.max(0, x[0]), x[1])
        const oy = Math.min(Math.max(0, y[0]), y[1])
        const xa = map([x[0], oy])
        const xb = map([x[1], oy])
        const ya = map([ox, y[0]])
        const yb = map([ox, y[1]])
        pen.line(xa, xb)
        pen.head(xb, xa, headSize)
        pen.line(ya, yb)
        pen.head(yb, ya, headSize)
        const names = Array.isArray(o.labels) ? o.labels : []
        const xl = typeof names[0] === 'string' ? names[0] : 'x'
        const yl = typeof names[1] === 'string' ? names[1] : 'y'
        label(xl, xb, [0.4, 1], 3)
        label(yl, yb, [1, 0.3], 4)
        if (o.ticks !== false) {
          const tick = size * 0.18
          const numbers = o.numbers !== false
          const steps = (lo: number, hi: number, step: number) => {
            const out: number[] = []
            for (
              let v = Math.ceil((lo + step * 0.4) / step) * step;
              v <= hi - step * 0.4;
              v += step
            ) {
              if (Math.abs(v) > step * 1e-6) out.push(v)
            }
            return out.slice(0, 14)
          }
          const tx = typeof o.ticks === 'number' && o.ticks > 0 ? o.ticks : niceStep(x[1] - x[0])
          const ty =
            typeof o.yticks === 'number' && o.yticks > 0
              ? o.yticks
              : typeof o.ticks === 'number' && o.ticks > 0
                ? o.ticks
                : niceStep(y[1] - y[0])
          for (const v of steps(x[0], x[1], tx)) {
            const p = map([v, oy])
            pen.line([p[0], p[1] - tick], [p[0], p[1] + tick])
            if (numbers) label(fmt(v), [p[0], p[1] + tick], [0, 1], 1.5)
          }
          for (const v of steps(y[0], y[1], ty)) {
            const p = map([ox, v])
            pen.line([p[0] - tick, p[1]], [p[0] + tick, p[1]])
            if (numbers) label(fmt(v), [p[0] - tick, p[1]], [-1, 0], 1.5)
          }
        }
        break
      }
      case 'plot':
      case 'parametric': {
        let points: Pt[]
        if (o.kind === 'plot') {
          const f = plotFn(o)
          if (!f) break
          points = sample(f, domain(o, world.x))
        } else points = paramPoints(o)
        const rs = runs(points)
        for (const r of rs) pen.poly(r, false, dashed)
        const end = rs.at(-1)?.at(-1)
        if (end) itemLabel(o, end, [0.6, -0.8])
        break
      }
      case 'point': {
        const p = pt(o.at) ?? pt(o.pos)
        if (!p) break
        pen.dot(map(p), Math.max(1.3, size * 0.07))
        itemLabel(o, map(p), [0.75, -0.75], 2)
        break
      }
      case 'label': {
        const p = pt(o.at) ?? pt(o.pos)
        const s = text(o, 'text') || text(o)
        const latex = text(o, 'latex')
        if (!p || (!s && !latex)) break
        const dirs: Record<string, Pt> = {
          above: [0, -1],
          below: [0, 1],
          left: [-1, 0],
          right: [1, 0],
        }
        const dir = dirs[text(o, 'side') || text(o, 'anchor')] ?? [0, 0]
        if (s) label(s, map(p), dir)
        else label(latex, map(p), dir, 3, true)
        break
      }
      case 'dimension': {
        const a = pt(o.from)
        const b = pt(o.to)
        if (!a || !b) break
        const [p, q] = [map(a), map(b)]
        const n = normal(p, q)
        const off = num(o.offset, size * 0.6)
        const p2: Pt = [p[0] + n[0] * off, p[1] + n[1] * off]
        const q2: Pt = [q[0] + n[0] * off, q[1] + n[1] * off]
        pen.line(p2, q2)
        pen.head(p2, q2, headSize * 0.8)
        pen.head(q2, p2, headSize * 0.8)
        itemLabel(o, lerp(p2, q2, 0.5), n, 2)
        break
      }
      case 'hatch': {
        const a = pt(o.from)
        const b = pt(o.to)
        if (!a || !b) break
        const [p, q] = [map(a), map(b)]
        pen.line(p, q)
        // Short slanted strokes on the far side: under a floor, behind a wall.
        const side = o.side === 'left' || o.side === 'above' ? 1 : -1
        const n = normal(p, q)
        const len = Math.hypot(q[0] - p[0], q[1] - p[1])
        const count = Math.max(3, Math.round(len / (size * 0.5)))
        const k = size * 0.42
        const u: Pt = [(q[0] - p[0]) / (len || 1), (q[1] - p[1]) / (len || 1)]
        for (let i = 0; i < count; i++) {
          const s = lerp(p, q, (i + 0.5) / count)
          pen.line(s, [
            s[0] + (n[0] * side - u[0] * 0.7) * k,
            s[1] + (n[1] * side - u[1] * 0.7) * k,
          ])
        }
        itemLabel(o, lerp(p, q, 0.5), [n[0] * -side, n[1] * -side])
        break
      }
      case 'spring': {
        const a = pt(o.from)
        const b = pt(o.to)
        if (!a || !b) break
        const [p, q] = [map(a), map(b)]
        const len = Math.hypot(q[0] - p[0], q[1] - p[1])
        if (len < 2) break
        const u: Pt = [(q[0] - p[0]) / len, (q[1] - p[1]) / len]
        const n: Pt = [-u[1], u[0]]
        const coils = Math.max(3, Math.min(14, Math.round(num(o.coils, 6))))
        const amp = num(o.width, 0) ? num(o.width, 0) * sx * 0.5 : Math.max(3, size * 0.32)
        const lead = len * 0.12
        const out: Pt[] = [p, [p[0] + u[0] * lead, p[1] + u[1] * lead]]
        const body = len - lead * 2
        for (let k = 0; k < coils * 2; k++) {
          const t = lead + (body * (k + 0.5)) / (coils * 2)
          const s = k % 2 ? -amp : amp
          out.push([p[0] + u[0] * t + n[0] * s, p[1] + u[1] * t + n[1] * s])
        }
        out.push([q[0] - u[0] * lead, q[1] - u[1] * lead], q)
        pen.poly(out)
        itemLabel(o, lerp(p, q, 0.5), [n[0], n[1]], amp + 2)
        break
      }
      default:
        if (CIRCUIT.has(o.kind)) drawCircuit(o, sketch)
        else if (OPTICS.has(o.kind)) drawOptics(o, sketch)
        else if (FIELDS.has(o.kind)) drawField(o, sketch)
        else if (o.kind === 'logic') drawLogic(o, sketch)
        else if (FREEHAND.has(o.kind)) drawFreehand(o, sketch, content)
    }
  }

  if (wired) {
    const placed = spec.items.filter((o) => o.kind === 'junction').map((o) => pt(o.at))
    for (const p of junctionDots(circuitSegments(spec.items))) {
      if (placed.some((q) => q && Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-3)) continue
      pen.dot(map(p), Math.max(1.4, size * 0.09))
    }
  }

  // The frame is wherever the ink went (labels can overhang it).
  const xs: number[] = []
  const ys: number[] = []
  for (const p of pen.paths) {
    for (let i = 0; i < p.length; i += 2) {
      xs.push(p[i] as number)
      ys.push(p[i + 1] as number)
    }
  }
  if (!xs.length) return { w: 0, h: 0, paths: [] }
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  return {
    w: Math.max(...xs) - x0,
    h: Math.max(...ys) - y0,
    paths: pen.paths.map((p) => p.map((n, i) => n - (i % 2 === 0 ? x0 : y0))),
  }
}
