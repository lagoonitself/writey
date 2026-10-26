import {
  type DiagramItem,
  deg,
  dist,
  lerp,
  num,
  type Pt,
  pt,
  type Sketch,
  text,
  unit,
} from './sketch'

// Fields and the other school-physics pictures: field lines traced from the real field
// (RK4 along E, as field-line simulators do), bar magnets, solenoids, the field around a
// wire, energy-level diagrams, wavefronts and slits.

export const FIELD_KINDS: Record<string, string> = {
  charges: 'charges',
  charge: 'charges',
  field: 'charges',
  field_lines: 'charges',
  electric_field: 'charges',
  dipole: 'charges',
  magnet: 'magnet',
  bar_magnet: 'magnet',
  solenoid: 'solenoid',
  current: 'current',
  wire_field: 'current',
  levels: 'levels',
  energy_levels: 'levels',
  wavefronts: 'wavefronts',
  wavefront: 'wavefronts',
  slits: 'slits',
  slit: 'slits',
  barrier: 'slits',
}

type Charge = { at: Pt; q: number; label: string }

function charges(o: DiagramItem): Charge[] {
  if (o.kind === 'charges' && Array.isArray(o.charges)) {
    return o.charges
      .map((c) => {
        const r = (c ?? {}) as Record<string, unknown>
        const at = pt(r.at) ?? pt(c)
        return at ? { at, q: num(r.q, 1), label: typeof r.label === 'string' ? r.label : '' } : null
      })
      .filter((c): c is Charge => !!c && c.q !== 0)
  }
  // A dipole, or a single charge: {"kind":"dipole","at":[0,0],"d":2}.
  const c = pt(o.at) ?? [0, 0]
  if (o.type === 'dipole' || o.kind === 'dipole' || num(o.d, 0) > 0) {
    const d = num(o.d ?? o.separation, 2) / 2
    const q = Math.abs(num(o.q, 1))
    return [
      { at: [c[0] - d, c[1]], q, label: '' },
      { at: [c[0] + d, c[1]], q: -q, label: '' },
    ]
  }
  return [{ at: c, q: num(o.q, 1), label: '' }]
}

/** The field of point charges (or magnetic poles) at p, unscaled. */
function fieldAt(cs: readonly Charge[], p: Pt): Pt {
  let ex = 0
  let ey = 0
  for (const c of cs) {
    const dx = p[0] - c.at[0]
    const dy = p[1] - c.at[1]
    const r2 = dx * dx + dy * dy
    const r3 = r2 * Math.sqrt(r2) || 1e-12
    ex += (c.q * dx) / r3
    ey += (c.q * dy) / r3
  }
  return [ex, ey]
}

/**
 * Follows a field line from `start` (sign −1 runs against the field) with RK4 steps of
 * fixed length, until it leaves the box, ends on a charge or `stop` says so.
 */
function trace(
  cs: readonly Charge[],
  start: Pt,
  sign: number,
  step: number,
  box: { x: [number, number]; y: [number, number] },
  stop: (p: Pt) => boolean,
): Pt[] {
  const dir = (p: Pt): Pt => {
    const e = fieldAt(cs, p)
    const m = Math.hypot(e[0], e[1]) || 1
    return [(sign * e[0]) / m, (sign * e[1]) / m]
  }
  const out: Pt[] = [start]
  let p = start
  for (let i = 0; i < 1500; i++) {
    const k1 = dir(p)
    const k2 = dir([p[0] + (k1[0] * step) / 2, p[1] + (k1[1] * step) / 2])
    const k3 = dir([p[0] + (k2[0] * step) / 2, p[1] + (k2[1] * step) / 2])
    const k4 = dir([p[0] + k3[0] * step, p[1] + k3[1] * step])
    p = [
      p[0] + (step * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0])) / 6,
      p[1] + (step * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])) / 6,
    ]
    out.push(p)
    if (p[0] < box.x[0] || p[0] > box.x[1] || p[1] < box.y[0] || p[1] > box.y[1]) break
    if (stop(p)) break
  }
  return out
}

function chargesExtent(cs: readonly Charge[]): Pt[] {
  const xs = cs.map((c) => c.at[0])
  const ys = cs.map((c) => c.at[1])
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  const pad = Math.max(1.2, span * 0.6)
  return [
    [Math.min(...xs) - pad, Math.min(...ys) - pad],
    [Math.max(...xs) + pad, Math.max(...ys) + pad],
  ]
}

export function fieldExtent(o: DiagramItem): Pt[] {
  const c = pt(o.at) ?? [0, 0]
  switch (o.kind) {
    case 'charges':
      return chargesExtent(charges(o))
    case 'magnet': {
      const L = num(o.length, 2)
      return [
        [c[0] - L * 1.3, c[1] - L * 0.85],
        [c[0] + L * 1.3, c[1] + L * 0.85],
      ]
    }
    case 'solenoid': {
      const a = pt(o.from) ?? [c[0] - 2, c[1]]
      const b = pt(o.to) ?? [c[0] + 2, c[1]]
      const r = num(o.r ?? o.radius, 0.5)
      const room = o.field === false ? 1.3 : 3.2
      return [
        [Math.min(a[0], b[0]) - r * 1.5, a[1] - r * room],
        [Math.max(a[0], b[0]) + r * 1.5, a[1] + r * room],
      ]
    }
    case 'current': {
      const R = num(o.r, 0.5) * Math.max(1, num(o.rings, 3)) * 1.15
      return [
        [c[0] - R, c[1] - R],
        [c[0] + R, c[1] + R],
      ]
    }
    case 'levels': {
      const ls = levels(o)
      const [x0, x1] = levelX(o)
      const es = ls.map((l) => l.e)
      return es.length
        ? [
            [x0, Math.min(...es)],
            [x1, Math.max(...es)],
          ]
        : []
    }
    case 'wavefronts': {
      const rs = radii(o)
      const R = Math.max(1, ...rs)
      return [
        [c[0] - R * 0.2, c[1] - R],
        [c[0] + R * 1.1, c[1] + R],
      ]
    }
    case 'slits': {
      const x = num(o.x, c[0])
      const [y0, y1] = barrierY(o)
      return [
        [x - 0.5, y0],
        [x + 0.5, y1],
      ]
    }
    default:
      return []
  }
}

export function drawField(o: DiagramItem, k: Sketch): void {
  switch (o.kind) {
    case 'charges':
      drawCharges(o, k)
      return
    case 'magnet':
      drawMagnet(o, k)
      return
    case 'solenoid':
      drawSolenoid(o, k)
      return
    case 'current':
      drawCurrent(o, k)
      return
    case 'levels':
      drawLevels(o, k)
      return
    case 'wavefronts':
      drawWavefronts(o, k)
      return
    case 'slits':
      drawSlits(o, k)
      return
  }
}

/** A small arrowhead along a traced line, pointing the way the line was traced. */
function arrowAlong(k: Sketch, line: readonly Pt[], t = 0.5): void {
  if (line.length < 4) return
  const i = Math.min(line.length - 2, Math.max(1, Math.floor(line.length * t)))
  const a = k.map(line[i - 1] as Pt)
  const b = k.map(line[i + 1] as Pt)
  if (dist(a, b) < 0.2) return
  const u = unit(a, b)
  const tip = k.map(line[i] as Pt)
  k.pen.head(tip, [tip[0] - u[0], tip[1] - u[1]], k.head * 0.75)
}

/** Field lines drawn as one pen stroke each, in page space. */
function drawLine(k: Sketch, line: readonly Pt[]): void {
  if (line.length < 2) return
  k.pen.poly(line.map(k.map))
  arrowAlong(k, line)
}

function drawCharges(o: DiagramItem, k: Sketch): void {
  const cs = charges(o)
  if (!cs.length) return
  const z = k.size
  const rPage = z * 0.38
  const r0 = rPage / k.sx
  const box = {
    x: [k.world.x[0], k.world.x[1]] as [number, number],
    y: [k.world.y[0], k.world.y[1]] as [number, number],
  }
  const step = Math.max(box.x[1] - box.x[0], box.y[1] - box.y[0]) / 220
  const per = Math.max(4, Math.min(16, Math.round(num(o.lines, 8))))
  const qmax = Math.max(...cs.map((c) => Math.abs(c.q)))
  const pos = cs.filter((c) => c.q > 0)
  const sources = pos.length ? pos : cs
  const sign = pos.length ? 1 : -1
  if (o.lines !== 0 && o.lines !== false) {
    for (const s of sources) {
      const n = Math.max(3, Math.round((per * Math.abs(s.q)) / qmax))
      const off = Math.PI / n / (sources.length > 1 ? 1 : 2)
      for (let j = 0; j < n; j++) {
        const a = off + (j / n) * Math.PI * 2
        const start: Pt = [s.at[0] + Math.cos(a) * r0 * 1.05, s.at[1] + Math.sin(a) * r0 * 1.05]
        const line = trace(cs, start, sign, step, box, (p) =>
          cs.some((c) => c !== s && Math.sign(c.q) !== Math.sign(s.q) && dist(p, c.at) < r0),
        )
        // Lines traced from negative charges point back toward them.
        drawLine(k, sign > 0 ? line : [...line].reverse())
      }
    }
    // Lines that come in from far away and end on a negative charge: traced back from it,
    // kept only when they don't start on a positive charge (those are drawn already).
    if (pos.length) {
      for (const s of cs.filter((c) => c.q < 0)) {
        const n = Math.max(3, Math.round((per * Math.abs(s.q)) / qmax))
        for (let j = 0; j < n; j++) {
          const a = Math.PI / n / 2 + (j / n) * Math.PI * 2
          const start: Pt = [s.at[0] + Math.cos(a) * r0 * 1.05, s.at[1] + Math.sin(a) * r0 * 1.05]
          const line = trace(cs, start, -1, step, box, (p) => pos.some((c) => dist(p, c.at) < r0))
          const end = line.at(-1) as Pt
          if (pos.some((c) => dist(end, c.at) < r0 * 1.5)) continue
          drawLine(k, [...line].reverse())
        }
      }
    }
  }
  for (const c of cs) {
    const p = k.map(c.at)
    k.pen.ellipse(p, rPage, rPage)
    const a = rPage * 0.5
    k.pen.line([p[0] - a, p[1]], [p[0] + a, p[1]])
    if (c.q > 0) k.pen.line([p[0], p[1] - a], [p[0], p[1] + a])
    if (c.label) k.label(c.label, p, [0.8, -0.8], rPage)
  }
  k.itemLabel(o, k.map(cs[0]?.at ?? [0, 0]), [0, 1], rPage + 4)
}

function drawMagnet(o: DiagramItem, k: Sketch): void {
  const c = pt(o.at) ?? [0, 0]
  const L = num(o.length, 2)
  const W = num(o.width, L * 0.28)
  const northLeft = text(o, 'north') === 'left'
  const nx = northLeft ? -1 : 1
  const pen = k.pen
  const corners: Pt[] = [
    [c[0] - L / 2, c[1] - W / 2],
    [c[0] + L / 2, c[1] - W / 2],
    [c[0] + L / 2, c[1] + W / 2],
    [c[0] - L / 2, c[1] + W / 2],
  ]
  pen.poly(corners.map(k.map), true)
  pen.line(k.map([c[0], c[1] - W / 2]), k.map([c[0], c[1] + W / 2]))
  k.label('N', k.map([c[0] + (nx * L) / 4, c[1]]), [0, 0], 0)
  k.label('S', k.map([c[0] - (nx * L) / 4, c[1]]), [0, 0], 0)
  // Poles a little inside the ends, as for a real bar magnet.
  const N: Pt = [c[0] + nx * L * 0.4, c[1]]
  const S: Pt = [c[0] - nx * L * 0.4, c[1]]
  const poles: { at: Pt; q: number; label: string }[] = [
    { at: N, q: 1, label: '' },
    { at: S, q: -1, label: '' },
  ]
  if (o.lines !== false && o.lines !== 0) {
    const inside = (p: Pt) => Math.abs(p[0] - c[0]) < L / 2 && Math.abs(p[1] - c[1]) < W / 2
    const box = {
      x: [k.world.x[0], k.world.x[1]] as [number, number],
      y: [k.world.y[0], k.world.y[1]] as [number, number],
    }
    const step = Math.max(box.x[1] - box.x[0], box.y[1] - box.y[0]) / 260
    const n = Math.max(2, Math.min(6, Math.round(num(o.lines, 4))))
    // Lines leave the north pole at spread-out angles and loop round to the south pole.
    const r0 = L * 0.12
    // A line that runs off the frame comes back into the south pole from the other side:
    // the field is mirror-symmetric about the magnet's middle, so draw its mirror image too.
    const fromN = (line: Pt[]) => {
      drawLine(k, line)
      const end = line.at(-1) as Pt
      if (inside(end) || dist(end, S) < r0) return
      drawLine(k, line.map(([x, y]): Pt => [2 * c[0] - x, y]).reverse())
    }
    for (let j = 0; j < n; j++) {
      const a = deg(28 + (j * 110) / Math.max(1, n - 1))
      for (const side of [1, -1]) {
        const start: Pt = [N[0] + nx * Math.cos(a) * r0, N[1] + side * Math.sin(a) * r0]
        if (inside(start)) {
          // Step out of the magnet along the field first.
          const out = trace(poles, start, 1, step, box, (p) => !inside(p))
          const line = trace(
            poles,
            out.at(-1) as Pt,
            1,
            step,
            box,
            (p) => inside(p) || dist(p, S) < r0,
          )
          fromN(line)
        } else fromN(trace(poles, start, 1, step, box, (p) => inside(p) || dist(p, S) < r0))
      }
    }
    // The axis line, straight out of each end.
    const e1 = k.map([c[0] + (nx * L) / 2, c[1]])
    const e2 = k.map([nx > 0 ? box.x[1] : box.x[0], c[1]])
    k.pen.line(e1, e2)
    k.pen.head(lerp(e1, e2, 0.6), e1, k.head * 0.75)
    const s1 = k.map([nx > 0 ? box.x[0] : box.x[1], c[1]])
    const s2 = k.map([c[0] - (nx * L) / 2, c[1]])
    k.pen.line(s1, s2)
    k.pen.head(lerp(s1, s2, 0.5), s1, k.head * 0.75)
  }
  k.itemLabel(o, k.map([c[0], c[1] + W / 2]), [0, -1], 3)
}

function drawSolenoid(o: DiagramItem, k: Sketch): void {
  const c = pt(o.at) ?? [0, 0]
  const a = pt(o.from) ?? [c[0] - 2, c[1]]
  const b = pt(o.to) ?? [c[0] + 2, c[1]]
  const r = num(o.r ?? o.radius, 0.5)
  const turns = Math.max(3, Math.min(20, Math.round(num(o.turns, 8))))
  const L = b[0] - a[0]
  const pitch = L / turns
  const out: Pt[] = []
  const N = turns * 24
  for (let j = 0; j <= N; j++) {
    const th = (j / N) * turns * Math.PI * 2
    out.push(k.map([a[0] + (L * j) / N - pitch * 0.3 * Math.sin(th), a[1] + r * Math.cos(th)]))
  }
  k.pen.poly(out)
  if (o.field !== false) {
    // Inside: straight lines from S to N. Outside: loops back round.
    const dir = text(o, 'north') === 'left' ? -1 : 1
    for (const y of [-0.35, 0, 0.35]) {
      const p = k.map([a[0] - r * 0.6, a[1] + y * r])
      const q = k.map([b[0] + r * 0.6, a[1] + y * r])
      k.pen.line(p, q)
      const mid = lerp(p, q, 0.5)
      k.pen.head([mid[0] + dir * k.head, mid[1]], [mid[0] - dir * k.head, mid[1]], k.head * 0.8)
    }
    const mx = (a[0] + b[0]) / 2
    for (const [i, ry] of [1.7, 2.6].entries()) {
      const rx = L / 2 + r * (0.9 + i * 0.7)
      for (const side of [1, -1]) {
        const arc: Pt[] = []
        for (let j = 0; j <= 30; j++) {
          const t = deg(12 + (156 * j) / 30)
          arc.push(k.map([mx + Math.cos(t) * rx, a[1] + side * Math.sin(t) * ry * r]))
        }
        k.pen.poly(arc)
        const top = arc[15] as Pt
        k.pen.head([top[0] - dir * k.head, top[1]], [top[0] + dir * k.head, top[1]], k.head * 0.8)
      }
    }
    k.label(dir > 0 ? 'N' : 'S', k.map([b[0] + r * 0.6, a[1]]), [1, 0], 4)
    k.label(dir > 0 ? 'S' : 'N', k.map([a[0] - r * 0.6, a[1]]), [-1, 0], 4)
  }
  k.itemLabel(o, k.map([(a[0] + b[0]) / 2, a[1] - r]), [0, 1], 4)
}

/** A wire seen end-on: a dot (current out of the page) or a cross (into it), with field circles. */
function drawCurrent(o: DiagramItem, k: Sketch): void {
  const c = pt(o.at) ?? [0, 0]
  const p = k.map(c)
  const z = k.size
  const rw = z * 0.3
  const into = /in/.test(text(o, 'dir') || text(o, 'direction'))
  k.pen.ellipse(p, rw, rw)
  if (into) {
    const d = rw * 0.6
    k.pen.line([p[0] - d, p[1] - d], [p[0] + d, p[1] + d])
    k.pen.line([p[0] - d, p[1] + d], [p[0] + d, p[1] - d])
  } else k.pen.dot(p, rw * 0.25)
  const rings = Math.max(1, Math.min(5, Math.round(num(o.rings, 3))))
  const r = num(o.r, 0.5)
  for (let i = 1; i <= rings; i++) {
    const R = r * i
    k.pen.ellipse(p, R * k.sx, R * k.sy)
    // Counter-clockwise for current out of the page (right-hand rule): leftward at the top.
    const top = k.map([c[0], c[1] + R])
    const d = into ? 1 : -1
    k.pen.head([top[0] + d * k.head * 0.6, top[1]], [top[0] - d * k.head, top[1]], k.head * 0.8)
  }
  k.itemLabel(o, p, [1, 1], rw + 2)
}

type Level = { n: number; e: number; label: string }

function levels(o: DiagramItem): Level[] {
  if (!Array.isArray(o.levels)) return []
  return o.levels
    .map((l, i) => {
      if (typeof l === 'number') return { n: i + 1, e: l, label: '' }
      const r = (l ?? {}) as Record<string, unknown>
      const e = num(r.e ?? r.E ?? r.energy ?? r.y, Number.NaN)
      return Number.isFinite(e)
        ? { n: num(r.n, i + 1), e, label: typeof r.label === 'string' ? r.label : '' }
        : null
    })
    .filter((l): l is Level => !!l)
}

const levelX = (o: DiagramItem): [number, number] => {
  const x = Array.isArray(o.x) ? o.x : [0, 4]
  return [num(x[0], 0), num(x[1], 4)]
}

function drawLevels(o: DiagramItem, k: Sketch): void {
  const ls = levels(o)
  const [x0, x1] = levelX(o)
  const unitName = text(o, 'unit') || 'eV'
  for (const l of ls) {
    const a = k.map([x0, l.e])
    const b = k.map([x1, l.e])
    k.pen.line(a, b)
    k.label(l.label || `n = ${l.n}`, b, [1, 0], 4)
    if (o.values !== false) k.label(`${l.e} ${unitName}`, a, [-1, 0], 4)
  }
  const ts = Array.isArray(o.transitions) ? o.transitions : []
  ts.forEach((t, i) => {
    const r = (t ?? {}) as Record<string, unknown>
    const from = ls.find((l) => l.n === num(r.from, Number.NaN))
    const to = ls.find((l) => l.n === num(r.to, Number.NaN))
    if (!from || !to) return
    const x = x0 + ((x1 - x0) * (i + 1)) / (ts.length + 1)
    const a = k.map([x, from.e])
    const b = k.map([x, to.e])
    k.pen.line(a, b)
    k.pen.head(b, a, k.head * 0.8)
    if (typeof r.label === 'string') k.label(r.label, lerp(a, b, 0.5), [1, 0], 3)
  })
  k.itemLabel(o, k.map([(x0 + x1) / 2, Math.max(...ls.map((l) => l.e))]), [0, -1], 8)
}

const radii = (o: DiagramItem): number[] =>
  Array.isArray(o.r) ? o.r.map((v) => num(v, 0)).filter((v) => v > 0) : [1, 2, 3]

/** Arcs of spherical wavefronts spreading from a point, or straight plane wavefronts. */
function drawWavefronts(o: DiagramItem, k: Sketch): void {
  const c = pt(o.at) ?? [0, 0]
  const rs = radii(o)
  const from = deg(num(o.from, -50))
  const to = deg(num(o.to, 50))
  if (o.plane === true) {
    const h = num(o.h ?? o.height, 2)
    for (const r of rs) k.pen.line(k.map([c[0] + r, c[1] - h / 2]), k.map([c[0] + r, c[1] + h / 2]))
  } else {
    k.pen.dot(k.map(c), Math.max(1.3, k.size * 0.07))
    for (const r of rs) {
      const arc: Pt[] = []
      for (let j = 0; j <= 24; j++) {
        const t = from + ((to - from) * j) / 24
        arc.push(k.map([c[0] + Math.cos(t) * r, c[1] + Math.sin(t) * r]))
      }
      k.pen.poly(arc)
    }
  }
  if (o.ray === true) {
    const R = Math.max(...rs) * 1.1
    const a = k.map(c)
    const b = k.map([c[0] + R, c[1]])
    k.pen.line(a, b)
    k.pen.head(b, a, k.head)
  }
  k.itemLabel(o, k.map([c[0] + Math.max(...rs), c[1]]), [1, 0], 4)
}

const barrierY = (o: DiagramItem): [number, number] => {
  const y = Array.isArray(o.y) ? o.y : [-2, 2]
  return [num(y[0], -2), num(y[1], 2)]
}

/** A barrier with gaps (single or double slit), or a plain screen when there are no gaps. */
function drawSlits(o: DiagramItem, k: Sketch): void {
  const c = pt(o.at) ?? [0, 0]
  const x = num(o.x, c[0])
  const [y0, y1] = barrierY(o)
  const gaps = (Array.isArray(o.gaps) ? o.gaps : [])
    .map((g) => pt(g))
    .filter((g): g is Pt => !!g)
    .map((g): Pt => [Math.min(g[0], g[1]), Math.max(g[0], g[1])])
    .sort((a, b) => a[0] - b[0])
  let y = y0
  for (const g of gaps) {
    if (g[0] > y) k.pen.line(k.map([x, y]), k.map([x, g[0]]))
    y = Math.max(y, g[1])
  }
  if (y < y1) k.pen.line(k.map([x, y]), k.map([x, y1]))
  k.itemLabel(o, k.map([x, y1]), [0, -1], 3)
}
