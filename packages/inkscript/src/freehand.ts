import { type DiagramItem, num, type Pt, pt, type Sketch, smooth, text } from './sketch'

// Pictures that can't be computed (biology, chemistry apparatus, geography): the model
// draws them with SVG path data, which models write well, and organic blobs; Writey draws
// every path with the pen and lines the part names up in neat columns with leader lines,
// the way textbook figures are labelled.

export const FREEHAND_KINDS: Record<string, string> = {
  svg: 'svg',
  outline: 'svg',
  drawing: 'svg',
  blob: 'blob',
  organic: 'blob',
  callouts: 'callouts',
  parts: 'callouts',
  labels: 'callouts',
  annotate: 'callouts',
}

// ---------------------------------------------------------------------------
// SVG path data → polylines
// ---------------------------------------------------------------------------

/** Parses an SVG path's `d` into polylines (one per subpath), in the path's own units. */
export function svgPath(d: string): Pt[][] {
  const toks = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []
  const out: Pt[][] = []
  let cur: Pt[] = []
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  let cmd = ''
  let lastCtrl: Pt | null = null
  let lastCmd = ''
  let i = 0
  const n = () => Number(toks[i++])
  const has = () => i < toks.length && !/^[a-zA-Z]$/.test(toks[i] as string)
  const flush = () => {
    if (cur.length > 1) out.push(cur)
    cur = []
  }
  const bez = (p0: Pt, c1: Pt, c2: Pt, p3: Pt) => {
    const len =
      Math.hypot(c1[0] - p0[0], c1[1] - p0[1]) +
      Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) +
      Math.hypot(p3[0] - c2[0], p3[1] - c2[1])
    const steps = Math.max(6, Math.min(40, Math.ceil(len / 3)))
    for (let k = 1; k <= steps; k++) {
      const t = k / steps
      const m = 1 - t
      cur.push([
        m * m * m * p0[0] + 3 * m * m * t * c1[0] + 3 * m * t * t * c2[0] + t * t * t * p3[0],
        m * m * m * p0[1] + 3 * m * m * t * c1[1] + 3 * m * t * t * c2[1] + t * t * t * p3[1],
      ])
    }
  }
  let guard = 0
  while (i < toks.length && guard++ < 20000) {
    if (/^[a-zA-Z]$/.test(toks[i] as string)) cmd = toks[i++] as string
    else if (!cmd) {
      i++
      continue
    }
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    if (C === 'Z') {
      if (cur.length) cur.push([sx, sy])
      x = sx
      y = sy
      flush()
      lastCmd = 'Z'
      continue
    }
    if (!has()) {
      cmd = ''
      continue
    }
    switch (C) {
      case 'M': {
        flush()
        x = ox + n()
        y = oy + n()
        sx = x
        sy = y
        cur = [[x, y]]
        // Further pairs after M are lines.
        cmd = rel ? 'l' : 'L'
        break
      }
      case 'L':
        x = ox + n()
        y = oy + n()
        cur.push([x, y])
        break
      case 'H':
        x = ox + n()
        cur.push([x, y])
        break
      case 'V':
        y = oy + n()
        cur.push([x, y])
        break
      case 'C': {
        const c1: Pt = [ox + n(), oy + n()]
        const c2: Pt = [ox + n(), oy + n()]
        const p: Pt = [ox + n(), oy + n()]
        if (!cur.length) cur = [[x, y]]
        bez([x, y], c1, c2, p)
        lastCtrl = c2
        ;[x, y] = p
        break
      }
      case 'S': {
        const c1: Pt =
          lastCtrl && /[CS]/.test(lastCmd) ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y]
        const c2: Pt = [ox + n(), oy + n()]
        const p: Pt = [ox + n(), oy + n()]
        if (!cur.length) cur = [[x, y]]
        bez([x, y], c1, c2, p)
        lastCtrl = c2
        ;[x, y] = p
        break
      }
      case 'Q':
      case 'T': {
        const q: Pt =
          C === 'Q'
            ? [ox + n(), oy + n()]
            : lastCtrl && /[QT]/.test(lastCmd)
              ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]]
              : [x, y]
        const p: Pt = [ox + n(), oy + n()]
        if (!cur.length) cur = [[x, y]]
        bez(
          [x, y],
          [x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y)],
          [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])],
          p,
        )
        lastCtrl = q
        ;[x, y] = p
        break
      }
      case 'A': {
        const rx0 = Math.abs(n())
        const ry0 = Math.abs(n())
        const rot = (n() * Math.PI) / 180
        const large = n() !== 0
        const sweep = n() !== 0
        const p: Pt = [ox + n(), oy + n()]
        if (!cur.length) cur = [[x, y]]
        arc(cur, [x, y], p, rx0, ry0, rot, large, sweep)
        ;[x, y] = p
        break
      }
      default:
        i++
    }
    lastCmd = C
    if (!/[CSQT]/.test(C)) lastCtrl = null
  }
  flush()
  return out.filter((p) => p.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1])))
}

/** SVG elliptical arc (endpoint form) sampled into `out`. */
function arc(
  out: Pt[],
  a: Pt,
  b: Pt,
  rx: number,
  ry: number,
  phi: number,
  large: boolean,
  sweep: boolean,
): void {
  if (!rx || !ry) {
    out.push(b)
    return
  }
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (a[0] - b[0]) / 2
  const dy = (a[1] - b[1]) / 2
  const x1 = cos * dx + sin * dy
  const y1 = -sin * dx + cos * dy
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (lam > 1) {
    rx *= Math.sqrt(lam)
    ry *= Math.sqrt(lam)
  }
  const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / den))
  const cx1 = (k * rx * y1) / ry
  const cy1 = (-k * ry * x1) / rx
  const cx = cos * cx1 - sin * cy1 + (a[0] + b[0]) / 2
  const cy = sin * cx1 + cos * cy1 + (a[1] + b[1]) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
  if (!sweep && dt > 0) dt -= Math.PI * 2
  if (sweep && dt < 0) dt += Math.PI * 2
  const steps = Math.max(6, Math.ceil((Math.abs(dt) * Math.max(rx, ry)) / 3))
  for (let s = 1; s <= steps; s++) {
    const t = t1 + (dt * s) / steps
    const ex = rx * Math.cos(t)
    const ey = ry * Math.sin(t)
    out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy])
  }
}

/** The item's paths, in world units: `d` (one string) or `paths` (several). */
function svgItemPaths(o: DiagramItem): Pt[][] {
  const ds = [o.d, ...(Array.isArray(o.paths) ? o.paths : [])].filter(
    (v): v is string => typeof v === 'string',
  )
  const polys = ds.flatMap(svgPath)
  // Optional placement: scale and shift the path's own units.
  const scale = num(o.scale, 1)
  const at = pt(o.at) ?? [0, 0]
  return polys.map((p) => p.map(([x, y]) => [at[0] + x * scale, at[1] + y * scale] as Pt))
}

// ---------------------------------------------------------------------------
// Blobs: organic closed shapes
// ---------------------------------------------------------------------------

function blobPoints(o: DiagramItem): Pt[] {
  const c = pt(o.center) ?? pt(o.at) ?? [0, 0]
  const rx = num(o.rx ?? o.r ?? o.w, 1)
  const ry = num(o.ry ?? o.r ?? o.h, rx)
  const wob = Math.min(0.4, Math.max(0, num(o.wobble ?? o.irregular, 0.12)))
  const seed = num(o.seed, rx * 7.3 + ry * 3.1 + c[0] + c[1])
  const n = 9
  const out: Pt[] = []
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2
    // Deterministic bumps, so the outline and its extent agree.
    const r =
      1 + wob * (Math.sin(seed * 12.9898 + k * 78.233) * 0.5 + Math.sin(seed + k * 2.1) * 0.5)
    out.push([c[0] + Math.cos(t) * rx * r, c[1] + Math.sin(t) * ry * r])
  }
  return smooth(out, true, 8)
}

// ---------------------------------------------------------------------------
// Callouts: part names in columns, each with a leader line
// ---------------------------------------------------------------------------

type Callout = { at: Pt; text: string; side: 'left' | 'right' | '' }

function callouts(o: DiagramItem): Callout[] {
  const list = Array.isArray(o.labels)
    ? o.labels
    : Array.isArray(o.parts)
      ? o.parts
      : Array.isArray(o.items)
        ? o.items
        : []
  return list.flatMap((r): Callout[] => {
    const v = (r ?? {}) as Record<string, unknown>
    const at = pt(v.at) ?? pt(v.point)
    const s =
      typeof v.text === 'string'
        ? v.text
        : typeof v.label === 'string'
          ? v.label
          : typeof v.name === 'string'
            ? v.name
            : ''
    if (!at || !s) return []
    const side = v.side === 'left' || v.side === 'right' ? v.side : ''
    return [{ at, text: s, side }]
  })
}

export function freehandExtent(o: DiagramItem): Pt[] {
  switch (o.kind) {
    case 'svg':
      return svgItemPaths(o).flat()
    case 'blob':
      return blobPoints(o)
    case 'callouts':
      // The names hang outside the drawing; only the points it labels count here.
      return callouts(o).map((c) => c.at)
    default:
      return []
  }
}

/** The drawing's box on the page, which callout names sit beside. */
export type PageBox = { L: number; T: number; R: number; B: number }

export function drawFreehand(o: DiagramItem, k: Sketch, content: PageBox): void {
  switch (o.kind) {
    case 'svg': {
      for (const p of svgItemPaths(o)) k.pen.poly(p.map(k.map), false, o.dashed === true)
      const l = text(o)
      if (l) {
        const ps = svgItemPaths(o).flat()
        if (ps.length) {
          const cx = ps.reduce((s, p) => s + p[0], 0) / ps.length
          const top = Math.max(...ps.map((p) => p[1]))
          k.label(l, k.map([cx, top]), [0, -1], 3)
        }
      }
      return
    }
    case 'blob': {
      k.pen.poly(blobPoints(o).map(k.map), false, o.dashed === true)
      const c = pt(o.center) ?? pt(o.at)
      if (c) k.itemLabel(o, k.map(c), [0, 0], 0)
      return
    }
    case 'callouts':
      drawCallouts(o, k, content)
      return
  }
}

/** Width a name takes when written, in points (about half an em per letter at label size). */
const nameWidth = (s: string, k: Sketch) => s.length * k.size * 0.62 * 0.5

function drawCallouts(o: DiagramItem, k: Sketch, content: PageBox): void {
  const cs = callouts(o)
  if (!cs.length) return
  const z = k.size
  const { L, T, R, B } = content
  const mid = (L + R) / 2
  const gap = z * 0.9
  const sides: Record<'left' | 'right', { p: Pt; text: string; y: number }[]> = {
    left: [],
    right: [],
  }
  for (const c of cs) {
    const p = k.map(c.at)
    const side =
      c.side ||
      (text(o, 'side') === 'left' || text(o, 'side') === 'right'
        ? (text(o, 'side') as 'left' | 'right')
        : p[0] < mid
          ? 'left'
          : 'right')
    sides[side].push({ p, text: c.text, y: p[1] })
  }
  const step = z * 0.62 * 1.45
  for (const side of ['left', 'right'] as const) {
    const col = sides[side].sort((a, b) => a.p[1] - b.p[1])
    if (!col.length) continue
    // Spread the names out so they never overlap, keeping each near its part's height.
    for (let i = 1; i < col.length; i++) {
      const prev = col[i - 1] as { y: number }
      const cur = col[i] as { y: number }
      cur.y = Math.max(cur.y, prev.y + step)
    }
    const over = (col.at(-1) as { y: number }).y - Math.max(B, (col.at(-1) as { p: Pt }).p[1])
    if (over > 0) {
      const room = Math.max(0, (col[0] as { y: number }).y - (T - step))
      const shift = Math.min(over, room)
      for (const c of col) c.y -= shift
      for (let i = 1; i < col.length; i++) {
        const prev = col[i - 1] as { y: number }
        const cur = col[i] as { y: number }
        cur.y = Math.max(cur.y, prev.y + step)
      }
    }
    const x = side === 'left' ? L - gap : R + gap
    for (const c of col) {
      const end: Pt = [x, c.y]
      k.pen.dot(c.p, Math.max(1.1, z * 0.06))
      // A short elbow keeps the leader lines parallel near the names.
      const knee: Pt = [x + (side === 'left' ? z * 0.6 : -z * 0.6), c.y]
      k.pen.poly([c.p, knee, end])
      k.label(c.text, end, [side === 'left' ? -1 : 1, 0], 3)
    }
  }
}

/**
 * Points the callout names need on each side, so the drawing can leave them room. A name
 * goes on the side of the drawing its part is on (`midX`, in the item's own units).
 */
export function calloutRoom(
  items: readonly DiagramItem[],
  k: Pick<Sketch, 'size'>,
  midX: number,
): { left: number; right: number } {
  const room = { left: 0, right: 0 }
  for (const o of items) {
    if (o.kind !== 'callouts') continue
    const forced = text(o, 'side')
    for (const c of callouts(o)) {
      const side =
        c.side ||
        (forced === 'left' || forced === 'right' ? forced : c.at[0] < midX ? 'left' : 'right')
      room[side] = Math.max(room[side], nameWidth(c.text, k as Sketch) + k.size * 1.4)
    }
  }
  return room
}
