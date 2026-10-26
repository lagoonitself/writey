import {
  BOND_EM,
  CHEM_KINDS,
  CHEM_SET,
  type ChemRefs,
  chemExtent,
  drawChem,
  expandChem,
} from './chem'
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
import { expandFigure, FIGURE_NAMES } from './figures'
import { calloutRoom, drawFreehand, FREEHAND_KINDS, freehandExtent, type PageBox } from './freehand'
import { drawGraph, endDot, fmtNum, GRAPH_KINDS, GRAPH_SET, graphExtent } from './graphs'
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
  /** Log scales: "log" on an axis, or log: "x" | "y" | "both". Also accepted on the axes item. */
  xscale?: 'log' | 'linear'
  yscale?: 'log' | 'linear'
  log?: 'x' | 'y' | 'both'
  items: DiagramItem[]
}

/** A drawn diagram in points, top-left at 0,0, y down, paths in drawing order. */
export type DrawnDiagram = { w: number; h: number; paths: Path[]; light?: Path[] }

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
  ...GRAPH_KINDS,
  ...CHEM_KINDS,
  figure: 'figure',
  picture: 'figure',
  // A figure's own name works as a kind too: {"kind":"heart"}.
  ...Object.fromEntries(FIGURE_NAMES.map((n) => [n, 'figure'])),
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

/** Evenly spaced on a log axis. */
function sampleLog(f: (x: number) => number, [a, b]: [number, number], n = 400): Pt[] {
  const lo = Math.log10(Math.max(a, 1e-12))
  const hi = Math.log10(Math.max(b, 1e-12))
  const out: Pt[] = []
  for (let k = 0; k <= n; k++) {
    const x = 10 ** (lo + ((hi - lo) * k) / n)
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
      if (GRAPH_SET.has(o.kind)) return graphExtent(o)
      if (CHEM_SET.has(o.kind)) return chemExtent(o)
      return []
  }
}

/** Log scales asked for on the diagram or its axes. */
function logScales(spec: DiagramSpec): { x: boolean; y: boolean } {
  const axes = spec.items.find((o) => o.kind === 'axes') as Record<string, unknown> | undefined
  const s = { ...spec, ...axes } as Record<string, unknown>
  const log = typeof s.log === 'string' ? s.log : s.log === true ? 'both' : ''
  return {
    x: s.xscale === 'log' || s.xlog === true || log === 'x' || log === 'both' || log === 'xy',
    y: s.yscale === 'log' || s.ylog === true || log === 'y' || log === 'both' || log === 'xy',
  }
}

const log10 = (v: number) => (v > 0 ? Math.log10(v) : Number.NaN)

/**
 * The world box, in y-up units (a y-down spec's y values are negated), after the log
 * scales: a log axis from 1 to 1000 is the range [0, 3].
 */
function fitWorld(
  spec: DiagramSpec,
  T: (p: Pt) => Pt,
  logs: { x: boolean; y: boolean },
): { x: [number, number]; y: [number, number] } {
  const fy = spec.ydown ? -1 : 1
  const axes = spec.items.find((o) => o.kind === 'axes')
  const xRaw = range(spec.x) ?? (axes && range(axes.x))
  const xr = xRaw && (logs.x ? ([log10(xRaw[0]), log10(xRaw[1])] as [number, number]) : xRaw)
  const y0 = range(spec.y) ?? (axes && range(axes.y))
  const yLog = y0 && logs.y ? ([log10(y0[0]), log10(y0[1])] as [number, number]) : y0
  const yr: [number, number] | null | undefined = yLog && (fy > 0 ? yLog : [-yLog[1], -yLog[0]])
  if (xr?.every(Number.isFinite) && yr?.every(Number.isFinite)) return { x: xr, y: yr }
  const all = spec.items
    .flatMap((o) => extent(o, xRaw ?? null))
    .map(T)
    .filter((p) => p.every(Number.isFinite))
    .map((p): Pt => [p[0], fy * p[1]])
  const xs = all.map((p) => p[0])
  const ys = all.map((p) => p[1])
  const pad = (lo: number, hi: number): [number, number] => {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [-1, 1]
    if (hi - lo < 1e-9) return [lo - 1, hi + 1]
    const m = (hi - lo) * 0.08
    return [lo - m, hi + m]
  }
  const ok = (r: [number, number] | null | undefined) => (r?.every(Number.isFinite) ? r : null)
  return {
    x: ok(xr) ?? pad(Math.min(...xs), Math.max(...xs)),
    y: ok(yr) ?? pad(Math.min(...ys), Math.max(...ys)),
  }
}

function niceStep(span: number, target = 6): number {
  const raw = span / target
  const p = 10 ** Math.floor(Math.log10(raw))
  const m = raw / p
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p
}

const fmt = fmtNum

/** Tick labels in multiples of π/2 (or π/k): "π/2", "π", "3π/2", "−π". */
function piLabel(v: number, den: number): string {
  const n = Math.round((v / Math.PI) * den)
  const g = gcd(Math.abs(n), den)
  const [a, b] = [n / g, den / g]
  const top = a === 1 ? '\\pi' : a === -1 ? '-\\pi' : `${a}\\pi`
  return b === 1 ? top : `${top}/${b}`
}
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a || 1)

/** A log axis's tick label: 1, 10, 100… while short, else 10^k. */
const decade = (k: number) => (k >= -2 && k <= 4 ? fmtNum(10 ** k) : `10^{${k}}`)

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
  // Library figures are drawn on a y-down canvas, so the whole diagram is.
  if (spec.items.some((o) => o.kind === 'figure')) {
    const items = spec.items.flatMap((o) => (o.kind === 'figure' ? (expandFigure(o) ?? []) : [o]))
    if (!items.length) return { w: 0, h: 0, paths: [] }
    spec = { ...spec, ydown: true, items }
  }
  // Reactions and lab set-ups are made of molecules, formulas, arrows and apparatus.
  if (spec.items.some((o) => o.kind === 'reaction' || o.kind === 'setup' || o.kind === 'curly'))
    spec = { ...spec, items: expandChem(spec.items) }
  const logs = logScales(spec)
  const T = (p: Pt): Pt => [logs.x ? log10(p[0]) : p[0], logs.y ? log10(p[1]) : p[1]]
  const world = fitWorld(spec, T, logs)
  const xr = world.x[1] - world.x[0]
  const yr = world.y[1] - world.y[0]
  // Circuits get a fixed scale (a gate is about two letters' height across), so a big
  // circuit gets a big drawing instead of being squeezed into the default width.
  const wired = spec.items.some((o) => CIRCUIT.has(o.kind) || o.kind === 'logic')
  const rayItems = spec.items.filter(
    (o) => o.kind === 'optics' || o.kind === 'lens' || o.kind === 'mirror',
  )
  const instrument = rayItems.some((o) => Array.isArray(o.elements) && o.elements.length > 1)
  // Chemistry is drawn at a fixed scale too: a bond about one and a half letters long.
  const chem = spec.items.some((o) => CHEM_SET.has(o.kind))
  const natural = chem
    ? Math.max(size * 4, xr * size * BOND_EM)
    : wired
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
  let W = Math.min(
    Math.max(size * 6, opts.maxW - room.left - room.right),
    Math.max(size * 4, num(spec.w, natural)),
  )
  // Pictures keep their proportions; a tall one gets narrower instead of squashed.
  const picture = (chem || spec.items.some((o) => FREEHAND.has(o.kind))) && !spec.h
  if (picture && !chem) W = Math.min(W, (size * 21 * xr) / yr)
  // Same scale on both axes unless told otherwise, so circles stay round.
  // Ray diagrams stretch their heights, as textbooks do, so rays don't lie flat on the axis.
  const rays = spec.items.some(
    (o) => o.kind === 'optics' || o.kind === 'lens' || o.kind === 'mirror',
  )
  const minH = W * (rays ? 0.62 : 0.4)
  const natH = picture ? (W * yr) / xr : Math.min(W * 1.15, Math.max(minH, (W * yr) / xr))
  // A ray diagram is never squashed flat, even when asked for a short frame.
  // Chemistry keeps one scale both ways, so rings stay regular.
  const H = chem
    ? natH
    : Math.max(size * 3, rays ? Math.max(num(spec.h, natH), minH) : num(spec.h, natH))
  const sx = W / xr
  const sy = H / yr
  const fy = spec.ydown ? -1 : 1
  /** Logged world → page. */
  const mapT = (p: Pt): Pt => [(p[0] - world.x[0]) * sx, H - (fy * p[1] - world.y[0]) * sy]
  const map = (p: Pt): Pt => mapT(T(p))
  const unmap = (q: Pt): Pt => {
    const u = q[0] / sx + world.x[0]
    const v = (fy * (H - q[1])) / sy + fy * world.y[0]
    return [logs.x ? 10 ** u : u, logs.y ? 10 ** v : v]
  }
  const raw = (lo: number, hi: number, log: boolean): [number, number] =>
    log ? [10 ** lo, 10 ** hi] : [lo, hi]
  const xRange = raw(world.x[0], world.x[1], logs.x)
  const yRange =
    fy > 0 ? raw(world.y[0], world.y[1], logs.y) : ([-world.y[1], -world.y[0]] as [number, number])
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
  const refs: ChemRefs = new Map()
  const sketch: Sketch = {
    rng,
    pen,
    map,
    unmap,
    xRange,
    yRange,
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
  /**
   * World points → screen runs, broken where the curve leaves the frame, blows up or jumps
   * (tan x at π/2, ⌊x⌋ at the integers).
   */
  const runs = (rawPoints: readonly Pt[]): Pt[][] => {
    const points = rawPoints.map(T)
    const out: Pt[][] = []
    let run: Pt[] = []
    const inside = (p: Pt) =>
      Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] >= yMin && p[1] <= yMax
    const dy = (i: number): number | null => {
      const a = points[i - 1]
      const b = points[i]
      const d = a && b ? Math.abs(b[1] - a[1]) : Number.NaN
      return Number.isFinite(d) ? d : null
    }
    /** A step much bigger than the steps either side of it is a jump, not a steep curve. */
    const jump = (i: number) => {
      const d = dy(i)
      if (d === null || d < yr * 0.01) return false
      if (d > yr * 0.45) return true
      const near = [dy(i - 1), dy(i + 1)].filter((v): v is number => v !== null)
      return near.length > 0 && d > Math.max(...near) * 8
    }
    for (let i = 0; i < points.length; i++) {
      const p = points[i] as Pt
      const prev = points[i - 1]
      if (inside(p) && run.length && prev && jump(i)) {
        if (run.length > 1) out.push(run)
        run = []
      }
      if (inside(p)) {
        if (!run.length && prev && Number.isFinite(prev[1])) {
          const edge = prev[1] > yMax ? yMax : yMin
          const t = (edge - prev[1]) / (p[1] - prev[1])
          if (t > 0 && t < 1) run.push(mapT([prev[0] + (p[0] - prev[0]) * t, edge]))
        }
        run.push(mapT(p))
      } else {
        if (run.length && prev && Number.isFinite(p[1]) && inside(prev)) {
          const edge = p[1] > yMax ? yMax : yMin
          const t = (edge - prev[1]) / (p[1] - prev[1])
          run.push(mapT([prev[0] + (p[0] - prev[0]) * t, edge]))
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
        // In logged units: a log axis from 1 to 1000 runs 0…3 here.
        const xr0 = range(o.x)
        const yr0 = range(o.y)
        const x: [number, number] =
          xr0 && logs.x ? [log10(xr0[0]), log10(xr0[1])] : (xr0 ?? world.x)
        const y: [number, number] =
          yr0 && logs.y ? [log10(yr0[0]), log10(yr0[1])] : (yr0 ?? world.y)
        // Axes cross at the origin when it is in view, else at the low end (always for log).
        const ox = logs.x ? x[0] : Math.min(Math.max(0, x[0]), x[1])
        const oy = logs.y ? y[0] : Math.min(Math.max(0, y[0]), y[1])
        const xa = mapT([x[0], oy])
        const xb = mapT([x[1], oy])
        const ya = mapT([ox, y[0]])
        const yb = mapT([ox, y[1]])
        const names = Array.isArray(o.labels) ? o.labels : []
        const xl = typeof names[0] === 'string' ? names[0] : 'x'
        const yl = typeof names[1] === 'string' ? names[1] : 'y'
        const tick = size * 0.18
        const numbers = o.numbers !== false
        /** Tick positions in logged units, with their labels (null: a minor tick). */
        const ticksFor = (
          lo: number,
          hi: number,
          log: boolean,
          step: unknown,
          pi: boolean,
        ): { v: number; label: string | null; latex: boolean }[] => {
          const out: { v: number; label: string | null; latex: boolean }[] = []
          if (log) {
            for (let k = Math.floor(lo); k <= Math.ceil(hi); k++) {
              if (k >= lo - 1e-9 && k <= hi + 1e-9)
                out.push({ v: k, label: decade(k), latex: true })
              if (hi - lo <= 6)
                for (const m of hi - lo <= 3 ? [2, 3, 4, 5, 6, 7, 8, 9] : [2, 5]) {
                  const v = k + Math.log10(m)
                  if (v > lo && v < hi) out.push({ v, label: null, latex: false })
                }
            }
            return out
          }
          if (pi) {
            const den = typeof o.pi === 'number' && o.pi > 0 ? Math.round(o.pi) : 2
            const st = Math.PI / den
            const span = (hi - lo) / st
            const every = Math.max(1, Math.ceil(span / 12))
            for (let n = Math.ceil(lo / st); n * st <= hi; n++) {
              if (n === 0 || n % every) continue
              out.push({ v: n * st, label: piLabel(n * st, den), latex: true })
            }
            return out
          }
          const st = typeof step === 'number' && step > 0 ? step : niceStep(hi - lo)
          for (let v = Math.ceil((lo + st * 0.4) / st) * st; v <= hi - st * 0.4; v += st) {
            if (Math.abs(v) > st * 1e-6) out.push({ v, label: fmt(v), latex: false })
          }
          return out.slice(0, 16)
        }
        const piX = o.pi === true || typeof o.pi === 'number' || o.pi === 'x'
        const xt = ticksFor(x[0], x[1], logs.x, o.ticks, piX)
        const yt = ticksFor(
          y[0],
          y[1],
          logs.y,
          typeof o.yticks === 'number' ? o.yticks : o.ticks,
          o.pi === 'y',
        )
        if (o.grid === true || o.grid === 'major' || o.grid === 'minor') {
          // A light grid, like squared or log paper.
          const minor = o.grid === 'minor' || logs.x || logs.y
          pen.faint(() => {
            for (const t of xt)
              if (t.label !== null || minor)
                pen.line(mapT([t.v, y[0]]), mapT([t.v, y[1]]), false, true)
            for (const t of yt)
              if (t.label !== null || minor)
                pen.line(mapT([x[0], t.v]), mapT([x[1], t.v]), false, true)
          })
        }
        pen.line(xa, xb)
        pen.head(xb, xa, headSize)
        pen.line(ya, yb)
        pen.head(yb, ya, headSize)
        label(xl, xb, [0.4, 1], 3, /\\/.test(xl))
        label(yl, yb, [1, 0.3], 4, /\\/.test(yl))
        if (o.ticks !== false) {
          for (const t of xt) {
            const p = mapT([t.v, oy])
            const k = t.label === null ? tick * 0.55 : tick
            pen.line([p[0], p[1] - k], [p[0], p[1] + k])
            if (numbers && t.label !== null)
              label(t.label, [p[0], p[1] + tick], [0, 1], 1.5, t.latex)
          }
          for (const t of yt) {
            const p = mapT([ox, t.v])
            const k = t.label === null ? tick * 0.55 : tick
            pen.line([p[0] - k, p[1]], [p[0] + k, p[1]])
            if (numbers && t.label !== null)
              label(t.label, [p[0] - tick, p[1]], [-1, 0], 1.5, t.latex)
          }
          if (numbers && o.origin === true && !logs.x && !logs.y)
            label('O', mapT([ox, oy]), [-0.8, 0.8], 2)
        }
        break
      }
      case 'plot':
      case 'parametric': {
        let points: Pt[]
        let f: ((x: number) => number) | null = null
        if (o.kind === 'plot') {
          f = plotFn(o)
          if (!f) break
          const xr0 = logs.x ? ([10 ** world.x[0], 10 ** world.x[1]] as [number, number]) : world.x
          const d = domain(o, xr0)
          points = logs.x ? sampleLog(f, d) : sample(f, d, 600)
        } else points = paramPoints(o)
        const rs = runs(points)
        for (const r of rs) pen.poly(r, false, dashed)
        if (f) {
          const F = f
          // Open or closed ends (piecewise functions) and holes (removable discontinuities).
          const d = domain(o, world.x)
          const ends = Array.isArray(o.ends)
            ? o.ends
            : typeof o.ends === 'string'
              ? [o.ends, o.ends]
              : []
          d.forEach((x, i) => {
            const e = ends[i]
            if (e !== 'open' && e !== 'closed') return
            const h = (d[1] - d[0]) * 1e-6 * (i ? -1 : 1)
            const yv = F(x + h)
            if (Number.isFinite(yv)) endDot(sketch, map([x, yv]), e === 'open')
          })
          for (const hx of Array.isArray(o.holes) ? o.holes : []) {
            const xv = num(hx, Number.NaN)
            if (!Number.isFinite(xv)) continue
            const yv = (F(xv - 1e-7) + F(xv + 1e-7)) / 2
            if (Number.isFinite(yv)) endDot(sketch, map([xv, yv]), true)
          }
        }
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
        else if (GRAPH_SET.has(o.kind)) drawGraph(o, sketch)
        else if (CHEM_SET.has(o.kind)) drawChem(o, sketch, refs)
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
  for (const p of [...pen.paths, ...pen.light]) {
    for (let i = 0; i < p.length; i += 2) {
      xs.push(p[i] as number)
      ys.push(p[i + 1] as number)
    }
  }
  if (!xs.length) return { w: 0, h: 0, paths: [] }
  let x0 = xs[0] as number
  let y0 = ys[0] as number
  let x1 = x0
  let y1 = y0
  for (const v of xs) {
    x0 = Math.min(x0, v)
    x1 = Math.max(x1, v)
  }
  for (const v of ys) {
    y0 = Math.min(y0, v)
    y1 = Math.max(y1, v)
  }
  const shift = (p: Path) => p.map((n, i) => n - (i % 2 === 0 ? x0 : y0))
  return {
    w: x1 - x0,
    h: y1 - y0,
    paths: pen.paths.map(shift),
    light: pen.light.length ? pen.light.map(shift) : undefined,
  }
}
