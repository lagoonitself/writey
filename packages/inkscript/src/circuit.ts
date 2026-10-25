import {
  type DiagramItem,
  dist,
  num,
  type Pt,
  pt,
  pts,
  quad,
  type Sketch,
  text,
  unit,
  upNormal,
} from './sketch'

// Circuit diagrams, drawn by hand. Placement follows Schemdraw's idea: a two-terminal part
// sits between two points with straight leads to its body, so the model only says where
// the ends are. Symbols follow Indian school textbooks (NCERT): zig-zag resistors, long and
// short cell plates, circled meters.

export const CIRCUIT_KINDS: Record<string, string> = {
  resistor: 'resistor',
  resistance: 'resistor',
  rheostat: 'rheostat',
  variable_resistor: 'rheostat',
  capacitor: 'capacitor',
  condenser: 'capacitor',
  cell: 'cell',
  battery: 'battery',
  inductor: 'inductor',
  coil: 'inductor',
  switch: 'switch',
  key: 'switch',
  plug_key: 'switch',
  bulb: 'bulb',
  lamp: 'bulb',
  ammeter: 'ammeter',
  voltmeter: 'voltmeter',
  galvanometer: 'galvanometer',
  meter: 'meter',
  diode: 'diode',
  zener: 'zener',
  led: 'led',
  ac: 'ac',
  ac_source: 'ac',
  source: 'ac',
  fuse: 'fuse',
  wire: 'wire',
  junction: 'junction',
  node: 'terminal',
  terminal: 'terminal',
  ground: 'ground',
  earth: 'ground',
  transistor: 'transistor',
  npn: 'transistor',
  pnp: 'transistor',
  gate: 'gate',
  and: 'gate',
  or: 'gate',
  not: 'gate',
  nand: 'gate',
  nor: 'gate',
  xor: 'gate',
}

/** Body length of each two-terminal part, in em. */
const BODY: Record<string, number> = {
  resistor: 1.5,
  rheostat: 1.5,
  capacitor: 0.32,
  cell: 0.3,
  battery: 0.95,
  inductor: 1.5,
  switch: 1.2,
  bulb: 0.95,
  ammeter: 1,
  voltmeter: 1,
  galvanometer: 1,
  meter: 1,
  diode: 0.7,
  zener: 0.7,
  led: 0.7,
  ac: 1,
  fuse: 1,
}

const METER_LETTER: Record<string, string> = { ammeter: 'A', voltmeter: 'V', galvanometer: 'G' }

/** Points a circuit item needs inside the frame. */
export function circuitExtent(o: DiagramItem): Pt[] {
  if (o.kind === 'wire') return [...pts(o.points), pt(o.from), pt(o.to)].filter((p): p is Pt => !!p)
  if (o.kind === 'junction' || o.kind === 'terminal' || o.kind === 'ground') {
    const p = pt(o.at)
    return p ? [p] : []
  }
  if (o.kind === 'transistor' || o.kind === 'gate') {
    const c = pt(o.at)
    if (!c) return []
    const s = num(o.size, 1)
    return [
      [c[0] - s, c[1] - s],
      [c[0] + s, c[1] + s],
    ]
  }
  return [pt(o.from), pt(o.to)].filter((p): p is Pt => !!p)
}

export function drawCircuit(o: DiagramItem, k: Sketch): void {
  switch (o.kind) {
    case 'wire': {
      const ps = pts(o.points)
      const line = ps.length >= 2 ? ps : [pt(o.from), pt(o.to)].filter((p): p is Pt => !!p)
      for (let i = 0; i + 1 < line.length; i++) {
        k.pen.line(k.map(line[i] as Pt), k.map(line[i + 1] as Pt), o.dashed === true)
      }
      const mid = line.length >= 2 ? midpoint(k.map(line[0] as Pt), k.map(line[1] as Pt)) : null
      if (mid) k.itemLabel(o, mid, upNormal(k.map(line[0] as Pt), k.map(line[1] as Pt)))
      return
    }
    case 'junction': {
      const p = pt(o.at)
      if (!p) return
      k.pen.dot(k.map(p), Math.max(1.4, k.size * 0.09))
      k.itemLabel(o, k.map(p), [-0.7, -0.7], 2)
      return
    }
    case 'terminal': {
      const p = pt(o.at)
      if (!p) return
      k.pen.ellipse(k.map(p), k.size * 0.12, k.size * 0.12)
      k.itemLabel(o, k.map(p), [-0.7, -0.7], 3)
      return
    }
    case 'ground': {
      const p = pt(o.at)
      if (!p) return
      const z = k.size
      const [x, y] = k.map(p)
      k.pen.line([x, y], [x, y + z * 0.45])
      for (const [i, w] of [0.45, 0.28, 0.12].entries()) {
        const yy = y + z * (0.45 + i * 0.15)
        k.pen.line([x - z * w, yy], [x + z * w, yy])
      }
      return
    }
    case 'transistor':
      transistor(o, k)
      return
    case 'gate':
      gate(o, k)
      return
    default:
      twoTerminal(o, k)
      return
  }
}

const midpoint = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

function twoTerminal(o: DiagramItem, k: Sketch): void {
  const a = pt(o.from)
  const b = pt(o.to)
  if (!a || !b) return
  const A = k.map(a)
  const B = k.map(b)
  const L = dist(A, B)
  if (L < 2) return
  const z = k.size
  const u = unit(A, B)
  const n = upNormal(A, B)
  const s = Math.min((BODY[o.kind] ?? 1) * z, L * 0.85)
  const t0 = (L - s) / 2
  /** A point `t` along the body and `v` off it (positive v is up or left). */
  const at = (t: number, v: number): Pt => [
    A[0] + u[0] * (t0 + t) + n[0] * v,
    A[1] + u[1] * (t0 + t) + n[1] * v,
  ]
  const pen = k.pen
  if (t0 > 0.5) {
    pen.line(A, at(0, 0))
    pen.line(at(s, 0), B)
  }
  let half = z * 0.3
  switch (o.kind) {
    case 'resistor':
    case 'rheostat': {
      const zig: Pt[] = [at(0, 0)]
      const teeth = 6
      for (let i = 0; i < teeth; i++)
        zig.push(at((s * (i + 0.5)) / teeth, (i % 2 ? -1 : 1) * z * 0.26))
      zig.push(at(s, 0))
      pen.poly(zig)
      if (o.kind === 'rheostat') {
        const from = at(s * 0.1, -z * 0.45)
        const to = at(s * 0.9, z * 0.5)
        pen.line(from, to)
        pen.head(to, from, k.head * 0.8)
        half = z * 0.5
      }
      break
    }
    case 'capacitor': {
      half = z * 0.55
      pen.line(at(0, -half), at(0, half))
      pen.line(at(s, -half), at(s, half))
      break
    }
    case 'cell':
    case 'battery': {
      // Long plate is +, short is −; the + side is at `from` unless flipped.
      const cells = o.kind === 'battery' ? Math.max(2, Math.min(4, Math.round(num(o.cells, 2)))) : 1
      const flip = o.flip === true || o.reverse === true
      const step = cells > 1 ? s / (cells * 2 - 1) : s
      half = z * 0.6
      for (let c = 0; c < cells * 2; c++) {
        const t = flip ? s - c * step : c * step
        const long = c % 2 === 0
        const h = long ? z * 0.6 : z * 0.3
        pen.line(at(t, -h), at(t, h))
      }
      if (cells > 1) {
        for (let c = 1; c < cells; c++) {
          const t = flip ? s - (2 * c - 1) * step : (2 * c - 1) * step
          const t2 = flip ? t - step : t + step
          pen.line(at(t, 0), at(t2, 0), true)
        }
      }
      if (o.signs === true) {
        k.label('+', at(flip ? s : 0, z * 0.8), [0, 0], 0)
        k.label('-', at(flip ? 0 : s, z * 0.8), [0, 0], 0)
      }
      break
    }
    case 'inductor': {
      const humps = 4
      const w = s / humps
      const out: Pt[] = []
      for (let i = 0; i < humps; i++) {
        for (let j = 0; j <= 10; j++) {
          const th = Math.PI * (1 - j / 10)
          out.push(at(i * w + (w / 2) * (1 + Math.cos(th)), Math.sin(th) * z * 0.35))
        }
      }
      pen.poly(out)
      half = z * 0.35
      break
    }
    case 'switch': {
      const r = z * 0.07
      pen.dot(at(0, 0), r)
      pen.dot(at(s, 0), r)
      if (o.closed === true) pen.line(at(0, 0), at(s, 0))
      else pen.line(at(0, 0), at(s * 0.92, z * 0.45))
      half = z * 0.45
      break
    }
    case 'bulb': {
      const r = s / 2
      const c = at(r, 0)
      pen.ellipse(c, r, r)
      const d = r * 0.7
      pen.line([c[0] - d, c[1] - d], [c[0] + d, c[1] + d])
      pen.line([c[0] - d, c[1] + d], [c[0] + d, c[1] - d])
      half = r
      break
    }
    case 'ammeter':
    case 'voltmeter':
    case 'galvanometer':
    case 'meter':
    case 'ac': {
      const r = s / 2
      const c = at(r, 0)
      pen.ellipse(c, r, r)
      if (o.kind === 'ac') {
        const wave: Pt[] = []
        for (let j = 0; j <= 16; j++) {
          const t = j / 16
          wave.push([c[0] - r * 0.55 + t * r * 1.1, c[1] - Math.sin(t * Math.PI * 2) * r * 0.35])
        }
        pen.poly(wave)
      } else {
        const letter = METER_LETTER[o.kind] ?? (text(o, 'letter') || 'M')
        k.label(letter, c, [0, 0], 0)
      }
      if (o.kind === 'galvanometer' || o.kind === 'ammeter' || o.kind === 'voltmeter') {
        if (o.signs === true) {
          k.label('+', at(-z * 0.15, z * 0.45), [0, 0], 0)
          k.label('-', at(s + z * 0.15, z * 0.45), [0, 0], 0)
        }
      }
      half = r
      break
    }
    case 'diode':
    case 'zener':
    case 'led': {
      const h = z * 0.35
      // Points from `from` (anode) to `to` (cathode): conventional current flows that way.
      pen.poly([at(0, -h), at(0, h), at(s, 0)], true)
      if (o.kind === 'zener')
        pen.poly([
          at(s - z * 0.12, h + z * 0.1),
          at(s, h),
          at(s, -h),
          at(s + z * 0.12, -h - z * 0.1),
        ])
      else pen.line(at(s, -h), at(s, h))
      if (o.kind === 'led') {
        for (const d of [0.25, 0.6]) {
          const from = at(s * d, h + z * 0.1)
          const to = at(s * d + z * 0.3, h + z * 0.45)
          pen.line(from, to)
          pen.head(to, from, k.head * 0.6)
        }
      }
      half = h
      break
    }
    case 'fuse': {
      const h = z * 0.18
      pen.poly([at(0, -h), at(s, -h), at(s, h), at(0, h)], true)
      pen.line(at(0, 0), at(s, 0))
      half = h
      break
    }
  }
  // Polarity arrow for current, when asked: {"current":"I"} draws an arrow along the wire.
  if (typeof o.current === 'string' && t0 > z * 0.5) {
    const p = at(-t0 * 0.55, 0)
    const q = at(-t0 * 0.2, 0)
    pen.head(q, p, k.head)
    k.label(o.current, midpoint(p, q), n, 3)
  }
  k.itemLabel(o, at(s / 2, 0), n, half + 2)
}

/** npn / pnp, with terminals: base at at − (size, 0), collector at at + (size/2, size), emitter at at + (size/2, −size). */
function transistor(o: DiagramItem, k: Sketch): void {
  const c = pt(o.at)
  if (!c) return
  const s = num(o.size, 1)
  const pnp = o.kind === 'transistor' && (text(o, 'type').toLowerCase() === 'pnp' || o.pnp === true)
  const w = (x: number, y: number): Pt => k.map([c[0] + x * s, c[1] + y * s])
  const pen = k.pen
  pen.ellipse(w(0.1, 0), 0.72 * s * k.sx, 0.72 * s * k.sy)
  pen.line(w(-1, 0), w(-0.25, 0))
  pen.line(w(-0.25, -0.42), w(-0.25, 0.42))
  pen.poly([w(-0.25, 0.2), w(0.5, 0.55), w(0.5, 1)])
  pen.poly([w(-0.25, -0.2), w(0.5, -0.55), w(0.5, -1)])
  // The arrow on the emitter: out of the base for npn, into it for pnp.
  const e0 = w(-0.25, -0.2)
  const e1 = w(0.5, -0.55)
  if (pnp) pen.head(w(-0.05, -0.29), e1, k.head * 0.8)
  else pen.head(w(0.38, -0.49), e0, k.head * 0.8)
  if (o.terminals !== false) {
    k.label('B', w(-1, 0), [0, -1], 2)
    k.label('C', w(0.5, 1), [1, 0], 3)
    k.label('E', w(0.5, -1), [1, 0], 3)
  }
  k.itemLabel(o, w(0.1, 0), [-1, -1], 0.72 * s * k.sx)
}

/** Logic gates. Inputs at at + (−size, ±size/4) (NOT: at − (size, 0)); output at at + (size, 0). */
function gate(o: DiagramItem, k: Sketch): void {
  const c = pt(o.at)
  if (!c) return
  const s = num(o.size, 1)
  const type = (o.kind === 'gate' ? text(o, 'type') : String(o.kind)).toLowerCase() || 'and'
  const w = (x: number, y: number): Pt => k.map([c[0] + x * s, c[1] + y * s])
  const pen = k.pen
  const bubble = type === 'nand' || type === 'nor' || type === 'not'
  const br = 0.08
  let tip = 0.45
  if (type === 'not') {
    pen.poly([w(-0.45, 0.35), w(-0.45, -0.35), w(0.3, 0)], true)
    pen.line(w(-1, 0), w(-0.45, 0))
    tip = 0.3
  } else if (type === 'and' || type === 'nand') {
    const arc: Pt[] = []
    for (let j = 0; j <= 14; j++) {
      const th = Math.PI / 2 - (j / 14) * Math.PI
      arc.push(w(-0.05 + Math.cos(th) * 0.4, Math.sin(th) * 0.4))
    }
    pen.poly([w(-0.05, -0.4), w(-0.55, -0.4), w(-0.55, 0.4), w(-0.05, 0.4), ...arc])
    for (const y of [0.25, -0.25]) pen.line(w(-1, y), w(-0.55, y))
    tip = 0.35
  } else {
    // OR family: a curved back and two curves meeting at the tip.
    const back = (dx: number) => quad(w(-0.55 + dx, 0.4), w(-0.35 + dx, 0), w(-0.55 + dx, -0.4))
    pen.poly(back(0))
    pen.poly([
      ...quad(w(-0.55, 0.4), w(0.15, 0.4), w(0.45, 0)),
      ...quad(w(0.45, 0), w(0.15, -0.4), w(-0.55, -0.4)).slice(1),
    ])
    if (type === 'xor') pen.poly(back(-0.12))
    for (const y of [0.25, -0.25]) pen.line(w(-1, y), w(type === 'xor' ? -0.6 : -0.47, y))
  }
  if (bubble) {
    const bc = w(tip + br, 0)
    pen.ellipse(bc, br * s * k.sx, br * s * k.sy)
    tip += br * 2
  }
  pen.line(w(tip, 0), w(1, 0))
  const name = text(o) || type.toUpperCase()
  k.label(name, w(-0.1, -0.4), [0, 1], 3)
}
