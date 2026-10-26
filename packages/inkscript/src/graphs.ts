import { compile, type Fn, holds, relations } from './expr'
import {
  type DiagramItem,
  deg,
  lerp,
  num,
  type Pt,
  pt,
  pts,
  range,
  type Sketch,
  text,
} from './sketch'

// School and university maths on the diagram pen: implicit curves, polar graphs, shaded
// regions and areas, asymptotes, tangents, slope and vector fields, sequences, statistics
// charts, number lines, Venn diagrams, probability trees and simple 3D. The model gives the
// maths; Writey works out the curves and draws them by hand.

export const GRAPH_KINDS: Record<string, string> = {
  implicit: 'implicit',
  equation: 'implicit',
  relation: 'implicit',
  conic: 'implicit',
  polar: 'polar',
  region: 'region',
  inequality: 'region',
  inequalities: 'region',
  shade: 'shade',
  area: 'shade',
  fill: 'shade',
  integral: 'shade',
  asymptote: 'asymptote',
  tangent: 'tangent',
  normal_line: 'tangent',
  slope_field: 'slope_field',
  direction_field: 'slope_field',
  vector_field: 'vector_field',
  points: 'points',
  scatter: 'points',
  data: 'points',
  sequence: 'sequence',
  bars: 'bars',
  bar: 'bars',
  bar_chart: 'bars',
  histogram: 'histogram',
  pie: 'pie',
  pie_chart: 'pie',
  boxplot: 'boxplot',
  box_plot: 'boxplot',
  box_and_whisker: 'boxplot',
  number_line: 'number_line',
  numberline: 'number_line',
  venn: 'venn',
  venn_diagram: 'venn',
  tree: 'tree',
  probability_tree: 'tree',
  tree_diagram: 'tree',
  axes3d: 'axes3d',
  point3d: 'point3d',
  line3d: 'line3d',
  segment3d: 'line3d',
  arrow3d: 'arrow3d',
  vector3d: 'arrow3d',
  polygon3d: 'polygon3d',
  plane3d: 'polygon3d',
}

const VARS_XY = ['x', 'y']
const VARS_T = ['t', 'theta', 'θ']

const fnOf = (o: DiagramItem, keys: string[], vars = ['x']): Fn | null => {
  const src = keys.map((k) => o[k]).find((v) => typeof v === 'string') as string | undefined
  return src ? compile(src.replace(/^\s*(y|r|f\(x\)|r\(θ\)|r\(t\))\s*=/, ''), vars) : null
}

const fx = (f: Fn) => (x: number) => f({ x })

/** Numbers, or the ends of a range written as "-inf"/"inf". */
const end = (v: unknown, d: number): number =>
  typeof v === 'string' && /inf/i.test(v) ? (v.startsWith('-') ? -1e9 : 1e9) : num(v, d)

// ---------------------------------------------------------------------------
// Implicit curves: marching squares, joined into strokes
// ---------------------------------------------------------------------------

/** f(x, y) = 0 as polylines in world units, over the box. */
export function contour(
  f: (x: number, y: number) => number,
  xr: [number, number],
  yr: [number, number],
  n = 140,
): Pt[][] {
  const nx = n
  const ny = n
  const dx = (xr[1] - xr[0]) / nx
  const dy = (yr[1] - yr[0]) / ny
  const v: number[] = []
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) v.push(f(xr[0] + i * dx, yr[0] + j * dy))
  const at = (i: number, j: number) => v[j * (nx + 1) + i] as number
  const segs: [Pt, Pt][] = []
  const cross = (i0: number, j0: number, i1: number, j1: number): Pt => {
    const a = at(i0, j0)
    const b = at(i1, j1)
    const t = a === b ? 0.5 : a / (a - b)
    return [xr[0] + (i0 + (i1 - i0) * t) * dx, yr[0] + (j0 + (j1 - j0) * t) * dy]
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]
      if (!c.every(Number.isFinite)) continue
      // Sign changes across a cell edge much bigger than the values nearby are poles, not zeros.
      const big = Math.max(...c.map(Math.abs))
      const edges: Pt[] = []
      const corners: [number, number][] = [
        [i, j],
        [i + 1, j],
        [i + 1, j + 1],
        [i, j + 1],
      ]
      for (let k = 0; k < 4; k++) {
        const a = c[k] as number
        const b = c[(k + 1) % 4] as number
        if (a < 0 !== b < 0) {
          const [i0, j0] = corners[k] as [number, number]
          const [i1, j1] = corners[(k + 1) % 4] as [number, number]
          edges.push(cross(i0, j0, i1, j1))
        }
      }
      if (big > 1e6) continue
      if (edges.length === 2) segs.push([edges[0] as Pt, edges[1] as Pt])
      else if (edges.length === 4) {
        segs.push([edges[0] as Pt, edges[1] as Pt], [edges[2] as Pt, edges[3] as Pt])
      }
    }
  }
  return join(segs, Math.min(dx, dy) * 1e-3)
}

/** Chains segments that share ends into polylines. */
function join(segs: [Pt, Pt][], eps: number): Pt[][] {
  const key = (p: Pt) => `${Math.round(p[0] / eps)},${Math.round(p[1] / eps)}`
  const ends = new Map<string, number[]>()
  segs.forEach((s, k) => {
    for (const p of s) {
      const id = key(p)
      const list = ends.get(id)
      if (list) list.push(k)
      else ends.set(id, [k])
    }
  })
  const used = new Set<number>()
  const out: Pt[][] = []
  const next = (p: Pt): number | undefined => ends.get(key(p))?.find((k) => !used.has(k))
  for (let k = 0; k < segs.length; k++) {
    if (used.has(k)) continue
    used.add(k)
    const s = segs[k] as [Pt, Pt]
    const line: Pt[] = [s[0], s[1]]
    for (const dir of [1, -1]) {
      for (;;) {
        const tip = (dir === 1 ? line.at(-1) : line[0]) as Pt
        const n = next(tip)
        if (n === undefined) break
        used.add(n)
        const [a, b] = segs[n] as [Pt, Pt]
        const far = key(a) === key(tip) ? b : a
        if (dir === 1) line.push(far)
        else line.unshift(far)
      }
    }
    out.push(line)
  }
  return out.filter((l) => l.length > 2)
}

// ---------------------------------------------------------------------------
// Shading: light hatch lines wherever a point is inside
// ---------------------------------------------------------------------------

/** Hatches every part of the frame where `inside(world point)` holds, with light strokes. */
function hatch(k: Sketch, inside: (p: Pt) => boolean, angle = 45, gap?: number): void {
  const [x0, x1] = k.xRange
  const [y0, y1] = k.yRange
  const a = k.map([x0, y0])
  const b = k.map([x1, y1])
  const L = Math.min(a[0], b[0])
  const R = Math.max(a[0], b[0])
  const T = Math.min(a[1], b[1])
  const B = Math.max(a[1], b[1])
  const s = gap ?? Math.max(3.2, k.size * 0.28)
  const th = deg(angle)
  const u: Pt = [Math.cos(th), -Math.sin(th)]
  const nrm: Pt = [-u[1], u[0]]
  const cx = (L + R) / 2
  const cy = (T + B) / 2
  const half = Math.hypot(R - L, B - T) / 2
  const step = Math.max(0.8, k.size * 0.06)
  k.pen.faint(() => {
    for (let o = -half; o <= half; o += s) {
      let run: Pt[] = []
      const flush = () => {
        if (run.length >= 2) k.pen.line(run[0] as Pt, run.at(-1) as Pt)
        run = []
      }
      for (let t = -half; t <= half; t += step) {
        const p: Pt = [cx + nrm[0] * o + u[0] * t, cy + nrm[1] * o + u[1] * t]
        if (p[0] < L || p[0] > R || p[1] < T || p[1] > B) {
          flush()
          continue
        }
        if (inside(k.unmap(p))) run.push(p)
        else flush()
      }
      flush()
    }
  })
}

// ---------------------------------------------------------------------------
// Venn diagrams
// ---------------------------------------------------------------------------

const VENN_CENTRES: Record<number, Pt[]> = {
  1: [[0, 0]],
  2: [
    [-0.6, 0],
    [0.6, 0],
  ],
  3: [
    [-0.6, 0.35],
    [0.6, 0.35],
    [0, -0.65],
  ],
}

/** A set expression ("A∩B'", "A|B", "(A-B)", "!C", "U") as a test on which sets a point is in. */
export function setTest(src: string, names: readonly string[]): (inSets: boolean[]) => boolean {
  const s = src
    .replace(/∩|\\cap|&&/g, '&')
    .replace(/∪|\\cup|\|\|/g, '|')
    .replace(/\\setminus|\\\\|∖/g, '-')
    .replace(/ᶜ|\^c|\^\{c\}|′/g, "'")
    .replace(/\s+/g, '')
  let i = 0
  type T = (m: boolean[]) => boolean
  const atom = (): T => {
    let f: T
    if (s[i] === '!' || s[i] === '~' || s[i] === '¬') {
      i++
      const g = atom()
      f = (m) => !g(m)
    } else if (s[i] === '(') {
      i++
      const g = union()
      if (s[i] === ')') i++
      f = g
    } else {
      const m = /^[A-Za-zξΩ][A-Za-z0-9]*/.exec(s.slice(i))
      let name = m?.[0] ?? ''
      const known = (n: string) => names.some((x) => x.toLowerCase() === n.toLowerCase())
      // "AB" is A then B when there is no set called AB.
      if (name && !known(name) && !/^(u|ξ|Ω|s|universe)$/i.test(name)) {
        const head = [...names]
          .sort((a, b) => b.length - a.length)
          .find((x) => name.toLowerCase().startsWith(x.toLowerCase()))
        if (head) name = name.slice(0, head.length)
      }
      i += name.length || 1
      const k = names.findIndex((n) => n.toLowerCase() === name.toLowerCase())
      f =
        k >= 0
          ? (mm) => mm[k] === true
          : /^(u|ξ|Ω|s|universe)$/i.test(name)
            ? () => true
            : () => false
    }
    while (s[i] === "'") {
      i++
      const g = f
      f = (m) => !g(m)
    }
    return f
  }
  const inter = (): T => {
    let f = atom()
    for (;;) {
      if (s[i] === '&') {
        i++
        const a = f
        const b = atom()
        f = (m) => a(m) && b(m)
      } else if (s[i] && /[A-Za-z(!~¬]/.test(s[i] as string)) {
        // "AB" or "A(B|C)" reads as an intersection, as in probability.
        const a = f
        const b = atom()
        f = (m) => a(m) && b(m)
      } else return f
    }
  }
  const union = (): T => {
    let f = inter()
    while (s[i] === '|' || s[i] === '-') {
      const op = s[i++]
      const a = f
      const b = inter()
      f = op === '|' ? (m) => a(m) || b(m) : (m) => a(m) && !b(m)
    }
    return f
  }
  try {
    return union()
  } catch {
    return () => false
  }
}

// ---------------------------------------------------------------------------
// Probability trees
// ---------------------------------------------------------------------------

type Branch = { label: string; p: string; children: Branch[] }

function branches(v: unknown): Branch[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((b): Branch[] => {
    if (typeof b === 'string') return [{ label: b, p: '', children: [] }]
    if (!b || typeof b !== 'object') return []
    const o = b as Record<string, unknown>
    const label = [o.label, o.to, o.name, o.outcome, o.event].find((x) => typeof x === 'string')
    const p = [o.p, o.prob, o.probability].find(
      (x) => typeof x === 'string' || typeof x === 'number',
    )
    return [
      {
        label: String(label ?? ''),
        p: p === undefined ? '' : String(p),
        children: branches(o.children ?? o.branches ?? o.then),
      },
    ]
  })
}

const leaves = (b: Branch[]): number => b.reduce((n, c) => n + Math.max(1, leaves(c.children)), 0)
const depth = (b: Branch[]): number =>
  b.length ? 1 + Math.max(...b.map((c) => depth(c.children))) : 0

// ---------------------------------------------------------------------------
// 3D: an oblique projection, x toward the viewer, y right, z up
// ---------------------------------------------------------------------------

const P3 = (v: unknown): [number, number, number] | null => {
  if (!Array.isArray(v) || v.length < 3) return null
  const p = v.slice(0, 3).map((n) => num(n, Number.NaN))
  return p.every(Number.isFinite) ? (p as [number, number, number]) : null
}

export const project = ([x, y, z]: [number, number, number]): Pt => [
  y - x * 0.5 * Math.SQRT1_2,
  z - x * 0.5 * Math.SQRT1_2,
]

// ---------------------------------------------------------------------------
// Extents (world units, y up) for fitting the frame
// ---------------------------------------------------------------------------

function polarPoints(o: DiagramItem): Pt[] {
  const f = fnOf(o, ['r', 'expr', 'fn'], VARS_T)
  if (!f) return []
  const [a, b] = range(o.theta ?? o.t ?? o.domain) ?? [0, Math.PI * 2]
  const out: Pt[] = []
  const n = 720
  for (let k = 0; k <= n; k++) {
    const t = a + ((b - a) * k) / n
    const r = f({ t, theta: t, θ: t })
    out.push([r * Math.cos(t), r * Math.sin(t)])
  }
  return out
}

function treeSize(o: DiagramItem): Pt {
  const b = branches(o.branches ?? o.children)
  return [Math.max(1, depth(b)) * 3 + 1.2, Math.max(1, leaves(b)) * 1.2]
}

function values(v: unknown): number[] {
  return Array.isArray(v) ? v.map((n) => num(n, Number.NaN)).filter(Number.isFinite) : []
}

function statFive(o: DiagramItem): number[] {
  const given = [o.min, o.q1, o.median, o.q3, o.max].map((v) => num(v, Number.NaN))
  if (given.every(Number.isFinite)) return given
  const d = values(o.data ?? o.values).sort((a, b) => a - b)
  if (!d.length) return []
  const q = (p: number) => {
    const i = (d.length - 1) * p
    const lo = Math.floor(i)
    return (d[lo] as number) + ((d[Math.ceil(i)] as number) - (d[lo] as number)) * (i - lo)
  }
  return [d[0] as number, q(0.25), q(0.5), q(0.75), d.at(-1) as number]
}

export function graphExtent(o: DiagramItem): Pt[] {
  switch (o.kind) {
    case 'polar':
      return polarPoints(o).filter((p) => p.every(Number.isFinite))
    case 'points':
      return pts(o.points ?? o.data)
    case 'sequence': {
      const f = fnOf(o, ['expr', 'a', 'fn'], ['n', 'x'])
      const [a, b] = range(o.n ?? o.domain) ?? [1, 10]
      if (!f) return []
      const out: Pt[] = []
      for (let n = Math.ceil(a); n <= b && out.length < 200; n++) out.push([n, f({ n, x: n })])
      return out.filter((p) => Number.isFinite(p[1]))
    }
    case 'bars': {
      const v = values(o.values ?? o.data)
      return v.length
        ? [
            [0, Math.min(0, ...v)],
            [v.length + 0.2, Math.max(0, ...v) * 1.08],
          ]
        : []
    }
    case 'histogram': {
      const e = values(o.bins ?? o.edges)
      const f = values(o.freq ?? o.values ?? o.counts)
      return e.length > 1 && f.length
        ? [
            [e[0] as number, 0],
            [e.at(-1) as number, Math.max(...f) * 1.08],
          ]
        : []
    }
    case 'pie': {
      const c = pt(o.center) ?? [0, 0]
      const r = num(o.r, 1) * 1.6
      return [
        [c[0] - r, c[1] - r],
        [c[0] + r, c[1] + r],
      ]
    }
    case 'boxplot': {
      const five = statFive(o)
      const y = num(o.y, 0)
      return five.length
        ? [
            [five[0] as number, y - 1],
            [five[4] as number, y + 1],
          ]
        : []
    }
    case 'number_line': {
      const [a, b] = range(o.range ?? o.x) ?? [-5, 5]
      return [
        [a, -0.6],
        [b, 0.6],
      ]
    }
    case 'venn': {
      const n = Math.min(3, Math.max(1, (Array.isArray(o.sets) ? o.sets.length : 2) || 2))
      return n === 3
        ? [
            [-2.1, -2.1],
            [2.1, 1.75],
          ]
        : [
            [-2.1, -1.45],
            [2.1, 1.45],
          ]
    }
    case 'tree': {
      const [w, h] = treeSize(o)
      return [
        [0, -h / 2],
        [w, h / 2],
      ]
    }
    case 'axes3d': {
      const s = num(o.size ?? o.length, 4)
      return [
        project([s, 0, 0]),
        project([0, s, 0]),
        project([0, 0, s]),
        [0, 0],
        project([0, -0.3 * s, -0.3 * s]),
      ]
    }
    case 'point3d':
      return [P3(o.at)].filter((p): p is [number, number, number] => !!p).map(project)
    case 'line3d':
    case 'arrow3d':
      return [P3(o.from), P3(o.to)].filter((p): p is [number, number, number] => !!p).map(project)
    case 'polygon3d':
      return (Array.isArray(o.points) ? o.points : [])
        .map(P3)
        .filter((p): p is [number, number, number] => !!p)
        .map(project)
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** A hollow ring (an excluded end or a hole) or a filled dot (an included end). */
export function endDot(k: Sketch, p: Pt, open: boolean): void {
  const r = Math.max(2, k.size * 0.14)
  if (open) k.pen.ellipse(p, r, r)
  else k.pen.dot(p, r)
}

export function drawGraph(o: DiagramItem, k: Sketch): void {
  const { pen, map, size } = k
  const dashed = o.dashed === true || o.style === 'dashed'
  const [wx0, wx1] = k.xRange
  const [wy0, wy1] = k.yRange
  switch (o.kind) {
    case 'implicit': {
      const src = [o.expr, o.equation, o.eq, o.f].find((v) => typeof v === 'string') as string
      if (!src) return
      const rs = relations(src, VARS_XY)
      const f = rs[0]?.f
      if (!f) return
      const lines = contour((x, y) => f({ x, y }), k.xRange, k.yRange)
      for (const l of lines) pen.poly(l.map(map), false, dashed)
      // The name goes by the curve's top-right point, out of the way of the axes.
      const all = lines.flat()
      const tip = all.length
        ? all.reduce((b, p) => (map(p)[0] - map(p)[1] > map(b)[0] - map(b)[1] ? p : b))
        : null
      if (tip) k.itemLabel(o, map(tip), [0.7, -0.7])
      return
    }
    case 'polar': {
      const ps = polarPoints(o)
      let run: Pt[] = []
      for (const p of ps) {
        if (p.every(Number.isFinite) && p[0] >= wx0 && p[0] <= wx1 && p[1] >= wy0 && p[1] <= wy1)
          run.push(map(p))
        else {
          if (run.length > 1) pen.poly(run, false, dashed)
          run = []
        }
      }
      if (run.length > 1) pen.poly(run, false, dashed)
      const tip = ps[Math.floor(ps.length * 0.12)]
      if (tip?.every(Number.isFinite)) k.itemLabel(o, map(tip), [0.7, -0.7])
      return
    }
    case 'region': {
      const raw = o.where ?? o.expr ?? o.inequalities ?? o.conditions
      const list = (Array.isArray(raw) ? raw : [raw]).filter(
        (v): v is string => typeof v === 'string',
      )
      const all = list.map((s) => relations(s, VARS_XY))
      const rs = all.flat()
      if (!rs.length) return
      hatch(k, ([x, y]) => holds(rs, { x, y }, 1e-6), num(o.angle, 45))
      if (o.border !== false) {
        // Each boundary is drawn only where the other conditions hold; dashed when strict.
        for (const r of rs) {
          const others = rs.filter((q) => q !== r)
          for (const l of contour((x, y) => r.f({ x, y }), k.xRange, k.yRange)) {
            let run: Pt[] = []
            for (const p of l) {
              if (holds(others, { x: p[0], y: p[1] }, 1e-6)) run.push(map(p))
              else {
                if (run.length > 1) pen.poly(run, false, r.op === '<' || r.op === '>')
                run = []
              }
            }
            if (run.length > 1) pen.poly(run, false, r.op === '<' || r.op === '>')
          }
        }
      }
      const c = pt(o.at)
      if (c) k.itemLabel(o, map(c), [0, 0], 0)
      return
    }
    case 'shade': {
      const f = fnOf(o, ['expr', 'under', 'f', 'fn', 'y'])
      const g = fnOf(o, ['between', 'g', 'and', 'lower'])
      const [a, b] = range(o.domain ?? o.x ?? [o.from, o.to]) ?? k.xRange
      if (!f) return
      const F = fx(f)
      const G = g ? fx(g) : () => 0
      hatch(
        k,
        ([x, y]) => {
          if (x < a || x > b) return false
          const u = F(x)
          const v = G(x)
          return (
            Number.isFinite(u) && Number.isFinite(v) && y >= Math.min(u, v) && y <= Math.max(u, v)
          )
        },
        num(o.angle, 45),
      )
      if (o.edges !== false) {
        for (const x of [a, b]) {
          const u = F(x)
          const v = G(x)
          if (Number.isFinite(u) && Number.isFinite(v) && Math.abs(u - v) > 1e-9)
            pen.line(map([x, v]), map([x, u]), true)
        }
      }
      const mid = (a + b) / 2
      const my = (F(mid) + G(mid)) / 2
      if (Number.isFinite(my)) k.itemLabel(o, map([mid, my]), [0, 0], 0)
      return
    }
    case 'asymptote': {
      const x = num(o.x, Number.NaN)
      const y = num(o.y, Number.NaN)
      if (Number.isFinite(x)) {
        pen.line(map([x, wy0]), map([x, wy1]), true)
        k.itemLabel(o, map([x, wy1]), [0.6, 1], 2)
      } else if (Number.isFinite(y)) {
        pen.line(map([wx0, y]), map([wx1, y]), true)
        k.itemLabel(o, map([wx1, y]), [-0.6, -1], 2)
      } else {
        // y = m x + c, oblique.
        const m = num(o.m ?? o.slope, Number.NaN)
        const c = num(o.c ?? o.intercept, 0)
        if (!Number.isFinite(m)) return
        const ys = (xx: number) => m * xx + c
        pen.line(map([wx0, ys(wx0)]), map([wx1, ys(wx1)]), true)
        k.itemLabel(o, map([wx1, ys(wx1)]), [-0.6, -1], 2)
      }
      return
    }
    case 'tangent': {
      const f = fnOf(o, ['expr', 'fn', 'f', 'curve'])
      const x0 = num(o.at ?? o.x, Number.NaN)
      if (!f || !Number.isFinite(x0)) return
      const F = fx(f)
      const h = Math.max(1e-6, Math.abs(x0) * 1e-5)
      const y0 = F(x0)
      let m = (F(x0 + h) - F(x0 - h)) / (2 * h)
      if (!Number.isFinite(y0) || !Number.isFinite(m)) return
      const normal = o.kind === 'tangent' && (o.normal === true || o.type === 'normal_line')
      if (normal) m = -1 / m
      const span = num(o.length, (wx1 - wx0) * 0.6) / 2
      const dx = span / Math.sqrt(1 + m * m * (k.sy / k.sx) ** 2)
      const a: Pt = [x0 - dx, y0 - m * dx]
      const b: Pt = [x0 + dx, y0 + m * dx]
      pen.line(map(a), map(b), dashed)
      pen.dot(map([x0, y0]), Math.max(1.3, size * 0.07))
      k.itemLabel(o, map(b), [0.6, -0.8], 2)
      return
    }
    case 'slope_field':
    case 'vector_field': {
      const n = Math.max(5, Math.min(25, Math.round(num(o.n ?? o.density, 13))))
      const dy = fnOf(o, ['dy', 'expr', 'slope', 'f'], VARS_XY)
      const fu = fnOf(o, ['u', 'dx', 'fx'], VARS_XY)
      const fv = fnOf(o, ['v', 'fy'], VARS_XY)
      const cell =
        Math.min(
          Math.abs(map([wx1, 0])[0] - map([wx0, 0])[0]),
          Math.abs(map([0, wy1])[1] - map([0, wy0])[1]),
        ) / n
      const len = cell * 0.62
      // Vector field arrows are scaled by the largest magnitude.
      const vecs: { p: Pt; v: Pt }[] = []
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const x = wx0 + ((i + 0.5) * (wx1 - wx0)) / n
          const y = wy0 + ((j + 0.5) * (wy1 - wy0)) / n
          let v: Pt
          if (o.kind === 'slope_field') {
            if (!dy) return
            const s = dy({ x, y })
            v = Number.isFinite(s) ? [1, s] : [0, 1]
          } else {
            if (!fu || !fv) return
            v = [fu({ x, y }), fv({ x, y })]
          }
          if (v.every(Number.isFinite)) vecs.push({ p: [x, y], v })
        }
      }
      const screen = (p: Pt, v: Pt): Pt => {
        const a = map(p)
        const b = map([p[0] + v[0] * 1e-3, p[1] + v[1] * 1e-3])
        return [b[0] - a[0], b[1] - a[1]]
      }
      const mags = vecs.map(({ p, v }) => Math.hypot(...screen(p, v)))
      const top = Math.max(1e-12, ...mags)
      vecs.forEach(({ p, v }, idx) => {
        const s = screen(p, v)
        const m = Math.hypot(s[0], s[1])
        if (m < 1e-12) return
        const c = map(p)
        const l =
          o.kind === 'slope_field' ? len : len * (0.35 + 0.65 * ((mags[idx] as number) / top))
        const u: Pt = [(s[0] / m) * l, (s[1] / m) * l]
        const a: Pt = [c[0] - u[0] / 2, c[1] - u[1] / 2]
        const b: Pt = [c[0] + u[0] / 2, c[1] + u[1] / 2]
        pen.line(a, b)
        if (o.kind === 'vector_field') pen.head(b, a, Math.max(2.2, l * 0.35))
      })
      return
    }
    case 'points': {
      const ps = pts(o.points ?? o.data)
      const names = Array.isArray(o.labels) ? o.labels : []
      if (o.connect === true || o.line === true) pen.poly(ps.map(map), false, dashed)
      ps.forEach((p, i) => {
        const q = map(p)
        if (o.hollow === true || o.open === true) endDot(k, q, true)
        else if (o.marker === 'cross' || o.marker === 'x') {
          const r = Math.max(2, size * 0.13)
          pen.line([q[0] - r, q[1] - r], [q[0] + r, q[1] + r])
          pen.line([q[0] - r, q[1] + r], [q[0] + r, q[1] - r])
        } else pen.dot(q, Math.max(1.3, size * 0.07))
        const n = names[i]
        if (typeof n === 'string' && n) k.label(n, q, [0.75, -0.75], 2, /\\/.test(n))
      })
      if (o.fit === 'linear' && ps.length > 1) {
        // Least-squares line of best fit, across the data.
        const mx = ps.reduce((s, p) => s + p[0], 0) / ps.length
        const my = ps.reduce((s, p) => s + p[1], 0) / ps.length
        const sxx = ps.reduce((s, p) => s + (p[0] - mx) ** 2, 0)
        const sxy = ps.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0)
        const m = sxx ? sxy / sxx : 0
        const xs = ps.map((p) => p[0])
        const a = Math.min(...xs)
        const b = Math.max(...xs)
        pen.line(map([a, my + m * (a - mx)]), map([b, my + m * (b - mx)]), true)
      }
      const last = ps.at(-1)
      if (last) k.itemLabel(o, map(last), [0.75, -0.75], 6)
      return
    }
    case 'sequence': {
      const f = fnOf(o, ['expr', 'a', 'fn'], ['n', 'x'])
      const [a, b] = range(o.n ?? o.domain) ?? [1, 10]
      if (!f) return
      for (let n = Math.ceil(a), c = 0; n <= b && c < 200; n++, c++) {
        const y = f({ n, x: n })
        if (!Number.isFinite(y) || y < wy0 || y > wy1) continue
        if (o.stems === true) pen.line(map([n, 0]), map([n, y]))
        pen.dot(map([n, y]), Math.max(1.3, size * 0.07))
      }
      if (Number.isFinite(num(o.limit, Number.NaN))) {
        const L = num(o.limit, 0)
        pen.line(map([wx0, L]), map([wx1, L]), true)
      }
      return
    }
    case 'bars':
    case 'histogram': {
      const hist = o.kind === 'histogram'
      const v = values(hist ? (o.freq ?? o.values ?? o.counts) : (o.values ?? o.data))
      const names = (Array.isArray(o.labels) ? o.labels : []).map((s) => String(s))
      const edges = values(o.bins ?? o.edges)
      const w = num(o.width, 0.6)
      v.forEach((h, i) => {
        const [a, b]: Pt = hist
          ? [edges[i] ?? i, edges[i + 1] ?? i + 1]
          : [i + 0.6 - w / 2, i + 0.6 + w / 2]
        const p0 = map([a, 0])
        const p1 = map([a, h])
        const p2 = map([b, h])
        const p3 = map([b, 0])
        pen.line(p0, p1)
        pen.line(p1, p2)
        pen.line(p2, p3)
        if (o.values_on_top !== false && o.numbers === true) k.label(String(h), p1, [1, -1], 2)
        if (!hist && names[i]) k.label(names[i] as string, lerp(p0, p3, 0.5), [0, 1], 3)
        if (o.shaded === true)
          hatch(k, ([x, y]) => x >= a && x <= b && y >= Math.min(0, h) && y <= Math.max(0, h))
      })
      // A baseline under the bars.
      const first = hist ? (edges[0] ?? 0) : 0
      const lastX = hist ? (edges.at(-1) ?? v.length) : v.length + 0.2
      if (o.baseline !== false) pen.line(map([first, 0]), map([lastX, 0]))
      return
    }
    case 'pie': {
      const v = values(o.values ?? o.data).map(Math.abs)
      const total = v.reduce((s, x) => s + x, 0)
      if (!total) return
      const c = map(pt(o.center) ?? [0, 0])
      const r = Math.abs(num(o.r, 1) * k.sx)
      pen.ellipse(c, r, r)
      const names = (Array.isArray(o.labels) ? o.labels : []).map((s) => String(s))
      let a = Math.PI / 2
      v.forEach((x, i) => {
        const sweep = (x / total) * Math.PI * 2
        pen.line(c, [c[0] + Math.cos(a) * r, c[1] - Math.sin(a) * r])
        const mid = a - sweep / 2
        const name = names[i] ?? ''
        const pct = o.percent === true ? `${Math.round((x / total) * 100)}%` : ''
        const s = [name, pct].filter(Boolean).join(' ')
        if (s)
          k.label(
            s,
            [c[0] + Math.cos(mid) * r, c[1] - Math.sin(mid) * r],
            [Math.cos(mid), -Math.sin(mid)],
            3,
          )
        a -= sweep
      })
      return
    }
    case 'boxplot': {
      const five = statFive(o)
      if (five.length !== 5) return
      const [mn, q1, md, q3, mx] = five as [number, number, number, number, number]
      const y = num(o.y, 0)
      const h = num(o.h, 0.6)
      const box = (x: number, dy: number): Pt => map([x, y + dy])
      pen.line(box(mn, 0), box(q1, 0))
      pen.line(box(q3, 0), box(mx, 0))
      for (const x of [mn, mx]) pen.line(box(x, -h / 3), box(x, h / 3))
      pen.poly([box(q1, -h / 2), box(q3, -h / 2), box(q3, h / 2), box(q1, h / 2)], true)
      pen.line(box(md, -h / 2), box(md, h / 2))
      if (o.numbers !== false) {
        for (const x of [mn, q1, md, q3, mx]) k.label(fmtNum(x), box(x, h / 2), [0, -1], 2)
      }
      k.itemLabel(o, box(mn, 0), [-1, 0], 4)
      return
    }
    case 'number_line': {
      const [a, b] = range(o.range ?? o.x) ?? [-5, 5]
      const p = (x: number): Pt => map([Math.min(b, Math.max(a, x)), 0])
      pen.line(p(a), p(b))
      pen.head(p(b), p(a), k.head)
      pen.head(p(a), p(b), k.head)
      const step = num(o.ticks ?? o.step, niceTick(b - a))
      const tick = size * 0.2
      for (let x = Math.ceil(a / step) * step; x <= b + 1e-9; x += step) {
        if (x - a < step * 0.3 || b - x < step * 0.3) continue
        const q = p(x)
        pen.line([q[0], q[1] - tick], [q[0], q[1] + tick])
        if (o.numbers !== false) k.label(fmtNum(x), [q[0], q[1] + tick], [0, 1], 1.5)
      }
      const lift = size * 0.55
      const ivs = Array.isArray(o.intervals) ? o.intervals : []
      ivs.forEach((iv, idx) => {
        if (!iv || typeof iv !== 'object') return
        const r = iv as Record<string, unknown>
        const x0 = end(r.from, a)
        const x1 = end(r.to, b)
        const open = Array.isArray(r.open) ? r.open : [r.open === true, r.open === true]
        const yy = -lift * (1 + idx * 0.7)
        const s = p(x0)
        const e = p(x1)
        const s2: Pt = [s[0], s[1] + yy]
        const e2: Pt = [e[0], e[1] + yy]
        pen.line(s2, e2)
        if (x0 <= a) pen.head(s2, e2, k.head)
        else {
          pen.line(s, s2, true)
          endDot(k, s2, open[0] === true)
        }
        if (x1 >= b) pen.head(e2, s2, k.head)
        else {
          pen.line(e, e2, true)
          endDot(k, e2, open[1] === true)
        }
        const l = typeof r.label === 'string' ? r.label : ''
        if (l) k.label(l, lerp(s2, e2, 0.5), [0, -1], 2, /\\/.test(l))
      })
      const marks = Array.isArray(o.points) ? o.points : []
      for (const m of marks) {
        const r: Record<string, unknown> =
          typeof m === 'number'
            ? { at: m }
            : m && typeof m === 'object'
              ? (m as Record<string, unknown>)
              : {}
        const x = num(r.at ?? r.x, Number.NaN)
        if (!Number.isFinite(x)) continue
        endDot(k, p(x), r.open === true)
        const l = typeof r.label === 'string' ? r.label : ''
        if (l) k.label(l, p(x), [0, -1], 4, /\\/.test(l))
      }
      return
    }
    case 'venn': {
      const names = (Array.isArray(o.sets) ? o.sets : ['A', 'B']).slice(0, 3).map(String)
      const n = Math.max(1, names.length)
      const cs = VENN_CENTRES[n] as Pt[]
      const R = 1
      const inSets = (p: Pt) => cs.map((c) => Math.hypot(p[0] - c[0], p[1] - c[1]) <= R)
      const shade = (
        Array.isArray(o.shade) ? o.shade : typeof o.shade === 'string' ? [o.shade] : []
      )
        .filter((s): s is string => typeof s === 'string')
        .map((s) => setTest(s, names))
      const [ux0, ux1] = [-2, 2]
      const [uy0, uy1] = n === 3 ? [-2, 1.65] : [-1.35, 1.35]
      if (shade.length) {
        hatch(k, (p) => {
          if (p[0] < ux0 || p[0] > ux1 || p[1] < uy0 || p[1] > uy1) return false
          const m = inSets(p)
          return shade.some((t) => t(m))
        })
      }
      if (o.universe !== false) {
        pen.poly([map([ux0, uy0]), map([ux1, uy0]), map([ux1, uy1]), map([ux0, uy1])], true)
        k.label(typeof o.universe === 'string' ? o.universe : 'U', map([ux0, uy1]), [1, 1], 4)
      }
      cs.forEach((c, i) => {
        const q = map(c)
        pen.ellipse(q, R * k.sx, R * k.sy)
        const out: Pt = n === 1 ? [0, 1] : [c[0] * 0.55, c[1] * 0.55 + (n === 2 ? 0.75 : 0)]
        const lp = map([c[0] + out[0] * 0.95, c[1] + out[1] * 0.95])
        const dir: Pt = [Math.sign(c[0]) || 0, c[1] < 0 ? 1 : -1]
        k.label(names[i] as string, lp, dir, 4)
      })
      // Numbers or elements written in regions: {"A&B": "5", "A-B": "3"}.
      if (o.regions && typeof o.regions === 'object') {
        for (const [expr, val] of Object.entries(o.regions as Record<string, unknown>)) {
          const t = setTest(expr, names)
          // The region's centre: the mean of grid points inside it.
          let sx = 0
          let sy = 0
          let c = 0
          for (let x = ux0 + 0.05; x < ux1; x += 0.1) {
            for (let y = uy0 + 0.05; y < uy1; y += 0.1) {
              if (t(inSets([x, y]))) {
                sx += x
                sy += y
                c++
              }
            }
          }
          if (c) k.label(String(val), map([sx / c, sy / c]), [0, 0], 0, /\\/.test(String(val)))
        }
      }
      return
    }
    case 'tree': {
      const b = branches(o.branches ?? o.children)
      if (!b.length) return
      const total = leaves(b)
      const dx = 3
      const dyLeaf = 1.2
      let next = (total * dyLeaf) / 2 - dyLeaf / 2
      const root = text(o, 'root') || text(o, 'label')
      // Each branch ends at the middle of its leaves; children start where its name ends.
      const walkFrom = (list: Branch[], from: Pt, level: number): void => {
        for (const c of list) {
          const n = Math.max(1, leaves(c.children))
          const top = next
          const y = top - ((n - 1) * dyLeaf) / 2
          const to: Pt = [dx * (level + 1), y]
          const a = map([from[0], from[1]])
          const e = map(to)
          pen.line(a, e)
          if (c.p) {
            const mid = lerp(a, e, 0.5)
            k.label(c.p, mid, [-0.3, e[1] < a[1] ? -1 : 1], 4, /\\/.test(c.p))
          }
          if (c.label) k.label(c.label, e, [1, 0], 3, /\\/.test(c.label))
          if (c.children.length) {
            next = top
            walkFrom(c.children, [dx * (level + 1) + 0.9, y], level + 1)
          }
          next = top - n * dyLeaf
        }
      }
      if (root) k.label(root, map([0, 0]), [-1, 0], 2, /\\/.test(root))
      walkFrom(b, [0.15, 0], 0)
      return
    }
    case 'axes3d': {
      const s = num(o.size ?? o.length, 4)
      const names = Array.isArray(o.labels) ? o.labels.map(String) : ['x', 'y', 'z']
      const O = map([0, 0])
      const axes: [number, number, number][] = [
        [s, 0, 0],
        [0, s, 0],
        [0, 0, s],
      ]
      axes.forEach((v, i) => {
        const tip = map(project(v))
        // The hidden negative half is dashed.
        const back = map(project(v.map((c) => -c * 0.3) as [number, number, number]))
        pen.line(back, O, true)
        pen.line(O, tip)
        pen.head(tip, O, k.head)
        const u: Pt = [tip[0] - O[0], tip[1] - O[1]]
        const m = Math.hypot(u[0], u[1]) || 1
        k.label(names[i] ?? '', tip, [u[0] / m, u[1] / m], 3)
      })
      if (o.origin !== false) k.label('O', O, [-0.8, 0.8], 2)
      return
    }
    case 'point3d': {
      const p = P3(o.at)
      if (!p) return
      const q = map(project(p))
      pen.dot(q, Math.max(1.3, size * 0.07))
      if (o.guides !== false) {
        // Dashed guide lines down to the xy-plane and across to the axes, as in textbooks.
        const foot = map(project([p[0], p[1], 0]))
        pen.line(q, foot, true)
        pen.line(foot, map(project([p[0], 0, 0])), true)
        pen.line(foot, map(project([0, p[1], 0])), true)
      }
      k.itemLabel(o, q, [0.75, -0.75], 2)
      return
    }
    case 'line3d':
    case 'arrow3d': {
      const a = P3(o.from) ?? [0, 0, 0]
      const b = P3(o.to)
      if (!b) return
      const p = map(project(a))
      const q = map(project(b))
      pen.line(p, q, dashed)
      if (o.kind === 'arrow3d') pen.head(q, p, k.head)
      const u: Pt = [q[0] - p[0], q[1] - p[1]]
      const m = Math.hypot(u[0], u[1]) || 1
      k.itemLabel(o, o.kind === 'arrow3d' ? q : lerp(p, q, 0.5), [u[0] / m, u[1] / m], 2)
      return
    }
    case 'polygon3d': {
      const ps = (Array.isArray(o.points) ? o.points : [])
        .map(P3)
        .filter((p): p is [number, number, number] => !!p)
        .map((p) => map(project(p)))
      pen.poly(ps, true, dashed)
      if (ps.length) {
        const c: Pt = [
          ps.reduce((s, p) => s + p[0], 0) / ps.length,
          ps.reduce((s, p) => s + p[1], 0) / ps.length,
        ]
        k.itemLabel(o, c, [0, 0], 0)
      }
      return
    }
  }
}

export function niceTick(span: number, target = 8): number {
  const raw = span / target
  const p = 10 ** Math.floor(Math.log10(raw))
  const m = raw / p
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p
}

export const fmtNum = (v: number): string => {
  const r = Math.round(v * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}

export const GRAPH_SET = new Set(Object.values(GRAPH_KINDS))
