import SmilesDrawer from 'smiles-drawer'
import { ceToLatex } from './ce'
import { project } from './graphs'
import { type Box, layoutMath, seeded } from './layout'
import {
  type DiagramItem,
  dist,
  lerp,
  num,
  type Pt,
  pt,
  type Sketch,
  smooth,
  text,
  unit,
} from './sketch'

// Chemistry drawn with Writey's pen (HANDOFF D50). Molecules come from SMILES: the
// open-source SmilesDrawer works out where the atoms go (rings, chains, double-bond sides,
// stereo wedges) and Writey draws every bond and label by hand. Around them: reaction
// schemes, curly arrows, energy profiles, orbital boxes, lab apparatus, crystal lattices
// and Newman, Fischer and chair projections. World units: one bond length.

export const CHEM_KINDS: Record<string, string> = {
  molecule: 'molecule',
  structure: 'molecule',
  smiles: 'molecule',
  compound: 'molecule',
  reaction: 'reaction',
  scheme: 'reaction',
  equation_scheme: 'reaction',
  curly: 'curly',
  curly_arrow: 'curly',
  mechanism_arrow: 'curly',
  ctext: 'ctext',
  formula: 'ctext',
  rarrow: 'rarrow',
  reaction_arrow: 'rarrow',
  energy_profile: 'energy_profile',
  energy_diagram: 'energy_profile',
  reaction_profile: 'energy_profile',
  orbital_boxes: 'orbital_boxes',
  electron_configuration: 'orbital_boxes',
  config: 'orbital_boxes',
  apparatus: 'apparatus',
  setup: 'setup',
  lab_setup: 'setup',
  lattice: 'lattice',
  unit_cell: 'lattice',
  newman: 'newman',
  fischer: 'fischer',
  chair: 'chair',
}

export const CHEM_SET = new Set(Object.values(CHEM_KINDS))

/** Points per bond length when nothing has to shrink. */
export const BOND_EM = 1.5

// ---------------------------------------------------------------------------
// Molecules: SMILES → atoms and bonds (bond length 1, y down, centred)
// ---------------------------------------------------------------------------

export type Atom = {
  el: string
  p: Pt
  nbrs: number[]
  /** Implicit hydrogens. */
  h: number
  charge: number
  /** Sum of bond orders to heavy atoms (aromatic bonds count 1.5). */
  order: number
  /** Written as a letter (not a bare skeletal carbon). */
  shown: boolean
  dir: 'left' | 'right' | 'up' | 'down'
}

export type Molecule = {
  atoms: Atom[]
  lines: { a: Pt; b: Pt; dashed: boolean }[]
  /** Stereo bonds, narrow end first. */
  wedges: { a: Pt; b: Pt; dashed: boolean }[]
  rings: { c: Pt; r: number }[]
  /** Bonds by atom index, with their order (1.5 aromatic). */
  bonds: { a: number; b: number; order: number }[]
  w: number
  h: number
}

type V2 = { x: number; y: number }
type SdLine = { from: V2; to: V2; getRightChiral(): boolean }
type SdVertex = {
  id: number
  position: V2
  neighbours: number[]
  value: {
    element: string
    bracket: { charge?: number; hcount?: number } | null
    isPartOfAromaticRing: boolean
    countImplicitHydrogens(): number
  }
}
type SdEdge = {
  sourceId: number
  targetId: number
  bondType: string
  isPartOfAromaticRing: boolean
}
type SdDrawer = {
  canvasWrapper: unknown
  graph: { vertices: SdVertex[]; edges: SdEdge[] }
  initDraw(tree: unknown, theme: string, infoOnly: boolean): void
  processGraph(): void
  drawEdges(debug: boolean): void
  drawVertices(debug: boolean): void
}

const BL = 30
const cache = new Map<string, Molecule | null>()

/** Atoms and bonds for a SMILES string, or null if it doesn't parse. */
export function molecule(smiles: string, allCarbons = false): Molecule | null {
  const key = `${allCarbons ? 'C' : 's'}|${smiles}`
  if (cache.has(key)) return cache.get(key) ?? null
  let out: Molecule | null = null
  try {
    out = layOut(smiles, allCarbons)
  } catch {
    out = null
  }
  cache.set(key, out)
  return out
}

function layOut(smiles: string, allCarbons: boolean): Molecule | null {
  const sd = SmilesDrawer as unknown as {
    Parser: { parse(s: string, o: object): unknown }
    SvgDrawer: new (o: object) => { preprocessor: SdDrawer }
  }
  const tree = sd.Parser.parse(smiles.trim(), {})
  const pre = new sd.SvgDrawer({
    showCarbons: allCarbons ? 'all' : 'default',
    compactDrawing: false,
  }).preprocessor
  const lines: Molecule['lines'] = []
  const wedges: Molecule['wedges'] = []
  const rings: Molecule['rings'] = []
  const texts = new Map<string, { dir: string }>()
  const v = (p: V2): Pt => [p.x / BL, p.y / BL]
  const ends = (l: SdLine): [Pt, Pt] => {
    const [a, b] = [v(l.from), v(l.to)]
    // Narrow end at the stereocentre.
    const leftFirst = l.from.x < l.to.x
    const [left, right] = leftFirst ? [a, b] : [b, a]
    return l.getRightChiral() ? [right, left] : [left, right]
  }
  pre.canvasWrapper = {
    drawLine: (l: SdLine, dashed = false) => lines.push({ a: v(l.from), b: v(l.to), dashed }),
    drawWedge: (l: SdLine) => {
      const [a, b] = ends(l)
      wedges.push({ a, b, dashed: false })
    },
    drawDashedWedge: (l: SdLine) => {
      const [a, b] = ends(l)
      wedges.push({ a, b, dashed: true })
    },
    drawAromaticityRing: (ring: { center: V2; members: number[] }) => {
      const n = ring.members.length
      const apothem = 1 / (2 * Math.tan(Math.PI / n))
      rings.push({ c: v(ring.center), r: apothem - 0.3 })
    },
    drawText: (x: number, y: number, _el: string, _h: number, dir: string) =>
      texts.set(`${Math.round(x)},${Math.round(y)}`, { dir }),
    drawPoint: () => {},
    drawBall: () => {},
    drawDebugText: () => {},
    drawDebugPoint: () => {},
  }
  pre.initDraw(tree, 'light', false)
  pre.processGraph()
  pre.drawEdges(false)
  pre.drawVertices(false)
  const { vertices, edges } = pre.graph
  if (!vertices.length) return null
  const order = vertices.map(() => 0)
  const bonds: Molecule['bonds'] = []
  for (const e of edges) {
    const o = e.isPartOfAromaticRing ? 1.5 : e.bondType === '=' ? 2 : e.bondType === '#' ? 3 : 1
    order[e.sourceId] = (order[e.sourceId] ?? 0) + o
    order[e.targetId] = (order[e.targetId] ?? 0) + o
    bonds.push({ a: e.sourceId, b: e.targetId, order: o })
  }
  const atoms: Atom[] = vertices.map((vx, i) => {
    const t = texts.get(`${Math.round(vx.position.x)},${Math.round(vx.position.y)}`)
    const el = vx.value.element
    let h = vx.value.countImplicitHydrogens()
    if (el === 'N' && vx.value.isPartOfAromaticRing && !vx.value.bracket) h = 0
    return {
      el: el.length > 1 ? el[0]?.toUpperCase() + el.slice(1).toLowerCase() : el.toUpperCase(),
      p: v(vx.position),
      nbrs: vx.neighbours,
      h,
      charge: vx.value.bracket?.charge ?? 0,
      order: order[i] ?? 0,
      shown: Boolean(t),
      dir: (t?.dir as Atom['dir']) ?? 'right',
    }
  })
  // Centre it.
  const xs = atoms.map((a) => a.p[0])
  const ys = atoms.map((a) => a.p[1])
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const c = (p: Pt): Pt => [p[0] - cx, p[1] - cy]
  for (const a of atoms) a.p = c(a.p)
  for (const l of lines) [l.a, l.b] = [c(l.a), c(l.b)]
  for (const w of wedges) [w.a, w.b] = [c(w.a), c(w.b)]
  for (const r of rings) r.c = c(r.c)
  return {
    atoms,
    lines,
    wedges,
    rings,
    bonds,
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  }
}

/**
 * A displayed formula on a grid, as textbooks draw open-chain molecules with every H:
 * the longest chain straight across, branches straight up or down, bonds at right angles.
 * Null for rings and stereo bonds (those keep the regular layout).
 */
export function gridLayout(m: Molecule): Molecule | null {
  const n = m.atoms.length
  if (m.rings.length || m.wedges.length || m.bonds.length !== n - 1 || n > 24) return null
  const adj = m.atoms.map((a) => a.nbrs)
  const far = (from: number) => {
    const d = m.atoms.map(() => -1)
    const prev = m.atoms.map(() => -1)
    d[from] = 0
    const q = [from]
    while (q.length) {
      const x = q.shift() as number
      for (const y of adj[x] ?? []) {
        if (d[y] !== -1) continue
        d[y] = (d[x] as number) + 1
        prev[y] = x
        q.push(y)
      }
    }
    let best = from
    d.forEach((v, i) => {
      if (v > (d[best] as number)) best = i
    })
    return { best, prev }
  }
  const a = far(0).best
  const { best: b, prev } = far(a)
  const chain: number[] = []
  for (let x = b; x !== -1; x = prev[x] as number) chain.push(x)
  const STEP = 1.35
  const pos: (Pt | null)[] = m.atoms.map(() => null)
  // The chain opens up beside a branch, so the branch's hydrogens fit between.
  let x = 0
  chain.forEach((i, k) => {
    const prevI = chain[k - 1]
    if (prevI !== undefined) {
      // Only between carbons: those are the ones with hydrogens above and below.
      const carbons = [prevI, i].every((c) => m.atoms[c]?.el === 'C')
      const branched = carbons && [prevI, i].some((c) => (adj[c]?.length ?? 0) > 2)
      x += branched ? STEP * 1.6 : STEP
    }
    pos[i] = [x, 0]
  })
  const dirs: Pt[] = [
    [0, -1],
    [0, 1],
    [1, 0],
    [-1, 0],
  ]
  const used = (i: number): Pt[] =>
    (adj[i] ?? []).flatMap((j) => {
      const p = pos[i]
      const q = pos[j]
      return p && q ? [[Math.sign(q[0] - p[0]), Math.sign(q[1] - p[1])] as Pt] : []
    })
  const occupied = (p: Pt) =>
    pos.some((q) => q && Math.abs(q[0] - p[0]) < 0.5 && Math.abs(q[1] - p[1]) < 0.5)
  const grow = (i: number, heading: Pt | null) => {
    for (const j of adj[i] ?? []) {
      if (pos[j]) continue
      const p = pos[i] as Pt
      const taken = used(i)
      const free = [heading, ...dirs].filter(
        (d): d is Pt =>
          !!d &&
          !taken.some((t) => t[0] === d[0] && t[1] === d[1]) &&
          !occupied([p[0] + d[0] * STEP, p[1] + d[1] * STEP]),
      )
      const d = free[0] ?? ([0, -1] as Pt)
      pos[j] = [p[0] + d[0] * STEP, p[1] + d[1] * STEP]
      grow(j, d)
    }
  }
  for (const i of chain) grow(i, null)
  if (pos.some((p) => !p)) return null
  const xs = pos.map((p) => (p as Pt)[0])
  const ys = pos.map((p) => (p as Pt)[1])
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const atoms = m.atoms.map((at, i) => ({
    ...at,
    p: [(pos[i] as Pt)[0] - cx, (pos[i] as Pt)[1] - cy] as Pt,
  }))
  const lines: Molecule['lines'] = []
  for (const bd of m.bonds) {
    const p = (atoms[bd.a] as Atom).p
    const q = (atoms[bd.b] as Atom).p
    const u = unit(p, q)
    const nrm: Pt = [-u[1], u[0]]
    const offs = bd.order >= 3 ? [-0.13, 0, 0.13] : bd.order >= 2 ? [-0.07, 0.07] : [0]
    for (const o of offs)
      lines.push({
        a: [p[0] + nrm[0] * o, p[1] + nrm[1] * o],
        b: [q[0] + nrm[0] * o, q[1] + nrm[1] * o],
        dashed: false,
      })
  }
  return {
    ...m,
    atoms,
    lines,
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  }
}

/** The layout a molecule is drawn with: a grid for full open-chain formulas. */
export function drawnMolecule(smiles: string, full: boolean, layout?: unknown): Molecule | null {
  const m = molecule(smiles, full)
  return (m && full && layout !== 'zigzag' && gridLayout(m)) || m
}

/** A molecule's box in bond lengths (y down, centred), letters and hydrogens included. */
export function molBounds(
  m: Molecule,
  full = false,
): { x0: number; x1: number; y0: number; y1: number } {
  let x0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (const a of m.atoms) {
    const reach = full ? 1.3 : a.shown ? 0.35 : 0.1
    const hx = !full && a.shown && a.h ? 0.5 : 0
    x0 = Math.min(x0, a.p[0] - reach - (a.dir === 'left' ? hx : 0))
    x1 = Math.max(x1, a.p[0] + reach + (a.dir === 'right' ? hx : 0))
    y0 = Math.min(y0, a.p[1] - reach)
    y1 = Math.max(y1, a.p[1] + reach)
  }
  return { x0, x1, y0, y1 }
}

/** Valence electrons, for lone pairs in Lewis structures. */
const VALENCE: Record<string, number> = {
  H: 1,
  B: 3,
  C: 4,
  N: 5,
  O: 6,
  F: 7,
  Si: 4,
  P: 5,
  S: 6,
  Cl: 7,
  Se: 6,
  Br: 7,
  I: 7,
  Xe: 8,
}

/** Directions (y down) round an atom farthest from what is already there. */
function freeDirections(taken: Pt[], n: number, prefer: Pt = [1, 0]): Pt[] {
  const angles = taken.map((d) => Math.atan2(d[1], d[0]))
  const out: Pt[] = []
  for (let k = 0; k < n; k++) {
    let best = Math.atan2(prefer[1], prefer[0])
    let score = -1
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2
      const gap = angles.length
        ? Math.min(...angles.map((b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))))
        : Math.PI
      if (gap > score + 1e-6) {
        score = gap
        best = a
      }
    }
    angles.push(best)
    out.push([Math.cos(best), Math.sin(best)])
  }
  return out
}

/**
 * Where an atom's hydrogens go, as a textbook draws them: a CH3 end fans out at right
 * angles, a CH2 in a chain puts one H on each side, and anything else fills the gaps.
 */
/** On a grid: up, down, then the ends of the chain. */
function gridDirections(taken: Pt[], n: number): Pt[] {
  // A chain end carries straight on first (H–C≡C–H, H–O–), then up and down.
  // An even number (=CH2) goes above and below instead.
  const ahead: Pt[] =
    taken.length === 1 && n % 2 === 1 ? [[-(taken[0] as Pt)[0], -(taken[0] as Pt)[1]]] : []
  const free = ([...ahead, [0, -1], [0, 1], [1, 0], [-1, 0]] as Pt[]).filter(
    (d) => !taken.some((t) => Math.abs(t[0] - d[0]) < 0.3 && Math.abs(t[1] - d[1]) < 0.3),
  )
  return [...free, ...freeDirections([...taken, ...free], Math.max(0, n - free.length))].slice(0, n)
}

function hydrogenDirections(taken: Pt[], n: number): Pt[] {
  const rot = (d: Pt, deg: number): Pt => {
    const a = (deg * Math.PI) / 180
    return [d[0] * Math.cos(a) - d[1] * Math.sin(a), d[0] * Math.sin(a) + d[1] * Math.cos(a)]
  }
  if (taken.length === 1 && n === 3) {
    const d = taken[0] as Pt
    return [rot(d, 90), rot(d, 180), rot(d, 270)]
  }
  if (taken.length === 2 && n === 2) {
    const [a, b] = taken as [Pt, Pt]
    const cross = a[0] * b[1] - a[1] * b[0]
    if (Math.abs(cross) < 0.15) {
      // A straight run: one above, one below.
      return [rot(a, 90), rot(a, -90)]
    }
    const out: Pt = [-(a[0] + b[0]), -(a[1] + b[1])]
    const m = Math.hypot(out[0], out[1]) || 1
    const u: Pt = [out[0] / m, out[1] / m]
    return [rot(u, 50), rot(u, -50)]
  }
  return freeDirections(taken, n)
}

// ---------------------------------------------------------------------------
// Writing labels at chemistry size
// ---------------------------------------------------------------------------

/** Writes LaTeX with its box centred on `at` (page points), at scale k. Returns its box. */
function put(k: Sketch, latex: string, at: Pt, scale: number, align: 'c' | 'l' | 'r' = 'c') {
  const box: Box = layoutMath(latex, k.rng)
  const w = box.w * scale
  const h = (box.h + box.d) * scale
  const x = align === 'c' ? at[0] - w / 2 : align === 'l' ? at[0] : at[0] - w
  const base = at[1] - h / 2 + box.h * scale
  for (const p of box.paths) {
    k.pen.paths.push(p.map((n, i) => (i % 2 === 0 ? x + n * scale : base + n * scale)))
  }
  return { x, y: at[1] - h / 2, w, h }
}

/** How big chemistry is drawn: one bond length in points, and the letter size with it. */
function scales(k: Sketch, o: DiagramItem) {
  const bond = Math.abs(k.sx) * num(o.size ?? o.scale, 1)
  // Atom letters are about half a bond tall, as in a textbook.
  const letter = Math.min(k.size * 0.9, bond * 0.55)
  return { bond, letter }
}

/** Where named atoms of drawn molecules are on the page, for curly arrows. */
export type ChemRefs = Map<string, { p: Pt; r: number }>

const chargeText = (c: number) =>
  c === 0 ? '' : `${Math.abs(c) > 1 ? Math.abs(c) : ''}${c > 0 ? '+' : '−'}`

// ---------------------------------------------------------------------------
// Drawing a molecule
// ---------------------------------------------------------------------------

function drawMolecule(o: DiagramItem, k: Sketch, refs: ChemRefs): void {
  const smiles = text(o, 'smiles') || text(o, 'structure')
  const mode = text(o, 'hydrogens') || (o.full === true ? 'all' : '')
  const lewis = o.lewis === true
  const full = lewis || mode === 'all' || o.explicit === true
  const laid = molecule(smiles, full || o.carbons === 'all')
  if (!laid) return
  const m = (full && o.layout !== 'zigzag' && gridLayout(laid)) || laid
  const { bond, letter } = scales(k, o)
  const at = pt(o.at) ?? pt(o.center) ?? [0, 0]
  const rot = (num(o.rotate, 0) * Math.PI) / 180
  const flip = o.flip === true ? -1 : 1
  const s = num(o.size ?? o.scale, 1)
  // Molecule units (y down) → world (y up) → page.
  const toPage = (p: Pt): Pt => {
    const x = p[0] * flip
    const y = p[1]
    const xr = x * Math.cos(rot) + y * Math.sin(rot)
    const yr = -x * Math.sin(rot) + y * Math.cos(rot)
    return k.map([at[0] + xr * s, at[1] - yr * s])
  }
  const atoms = m.atoms.map((a) => ({ ...a, q: toPage(a.p) }))
  const pen = k.pen
  const labelR = letter * 0.55
  const showC = full || o.carbons === 'all'
  const labelled = atoms.map((a) => a.shown || (showC && a.el === 'C') || (lewis && a.el === 'H'))

  /** Pulls a line end out of a written atom's letter. */
  const clip = (p: Pt, other: Pt): Pt => {
    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i] as (typeof atoms)[0]
      if (!labelled[i]) continue
      const d = dist(p, a.q)
      if (d < labelR * 1.05 && dist(other, a.q) > labelR) {
        const u = unit(p, other)
        // Move along the line until it leaves the circle round the letter.
        const proj = (a.q[0] - p[0]) * u[0] + (a.q[1] - p[1]) * u[1]
        const perp2 = d * d - proj * proj
        const t = proj + Math.sqrt(Math.max(0, labelR * labelR - perp2))
        return [p[0] + u[0] * t, p[1] + u[1] * t]
      }
    }
    return p
  }
  const bondLine = (a: Pt, b: Pt, dashed = false) => {
    const a2 = clip(a, b)
    const b2 = clip(b, a)
    if (dist(a2, b2) > 1) pen.line(a2, b2, dashed, true)
  }
  for (const l of m.lines) bondLine(toPage(l.a), toPage(l.b), l.dashed)
  for (const r of m.rings) {
    const c = toPage(r.c)
    pen.ellipse(c, r.r * bond, r.r * bond)
  }
  for (const w of m.wedges) {
    const a = clip(toPage(w.a), toPage(w.b))
    const b = clip(toPage(w.b), toPage(w.a))
    const u = unit(a, b)
    const n: Pt = [-u[1], u[0]]
    const half = bond * 0.11
    if (w.dashed) {
      // Hashes that widen toward the far atom.
      const steps = 6
      for (let i = 1; i <= steps; i++) {
        const c = lerp(a, b, i / steps)
        const hw = (half * i) / steps
        pen.line([c[0] - n[0] * hw, c[1] - n[1] * hw], [c[0] + n[0] * hw, c[1] + n[1] * hw])
      }
    } else {
      // A solid wedge: its outline, then filled with tight zigzags.
      const l: Pt = [b[0] + n[0] * half, b[1] + n[1] * half]
      const r: Pt = [b[0] - n[0] * half, b[1] - n[1] * half]
      pen.poly([a, l, r], true)
      const fill: Pt[] = []
      const steps = Math.max(4, Math.round(dist(a, b) / 1.6))
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const c = lerp(a, b, t)
        const hw = half * t * (i % 2 ? 1 : -1)
        fill.push([c[0] + n[0] * hw, c[1] + n[1] * hw])
      }
      pen.poly([a, ...fill])
    }
  }

  // Explicit hydrogens (full structural formulas and Lewis structures).
  const hPos: Pt[][] = atoms.map(() => [])
  if (full) {
    // Every H keeps clear of the atoms and of the other hydrogens.
    const occupied: Pt[] = atoms.map((a) => a.q)
    const clear = (q: Pt) => occupied.every((o) => dist(o, q) > bond * 0.6)
    const grid = m !== laid
    // Chain atoms first, so a branch's hydrogens fit round its neighbours' ones.
    const order = atoms
      .map((a, i) => ({ i, branch: a.nbrs.length === 1 && a.p[1] !== 0 }))
      .sort((x, y) => Number(x.branch) - Number(y.branch))
      .map((x) => x.i)
    for (const i of order) {
      const a = atoms[i] as (typeof atoms)[0]
      if (a.el === 'H' || !a.h) continue
      const taken = a.nbrs.map((j) => unit(a.q, (atoms[j] as (typeof atoms)[0]).q))
      const wanted = grid ? gridDirections(taken, a.h) : hydrogenDirections(taken, a.h)
      const spare = freeDirections([...taken, ...wanted], 8)
      const ds: Pt[] = []
      for (const d of [...wanted, ...spare]) {
        if (ds.length === a.h) break
        if (clear([a.q[0] + d[0] * bond, a.q[1] + d[1] * bond])) {
          ds.push(d)
          occupied.push([a.q[0] + d[0] * bond, a.q[1] + d[1] * bond])
        }
      }
      for (const d of ds) {
        const q: Pt = [a.q[0] + d[0] * bond, a.q[1] + d[1] * bond]
        hPos[i]?.push(q)
        const from: Pt = labelled[i] ? [a.q[0] + d[0] * labelR, a.q[1] + d[1] * labelR] : a.q
        const to: Pt = [q[0] - d[0] * labelR, q[1] - d[1] * labelR]
        pen.line(from, to, false, true)
        put(k, '\\mathrm{H}', q, letter)
      }
    }
  }

  // Atom letters, with their hydrogens on the side away from the bonds, and charges.
  atoms.forEach((a, i) => {
    if (!labelled[i]) return
    const el = put(k, `\\mathrm{${a.el}}`, a.q, letter)
    let right = el.x + el.w
    let left = el.x
    const h = full ? 0 : a.h
    if (h) {
      const hs = `\\mathrm{H}${h > 1 ? `_{${h}}` : ''}`
      if (a.dir === 'left') {
        const b = put(k, hs, [left - letter * 0.04, a.q[1]], letter, 'r')
        left = b.x
      } else if (a.dir === 'up' || a.dir === 'down') {
        put(k, hs, [a.q[0], a.q[1] + (a.dir === 'up' ? -1 : 1) * letter * 0.8], letter)
      } else {
        const b = put(k, hs, [right + letter * 0.04, a.q[1]], letter, 'l')
        right = b.x + b.w
      }
    }
    if (a.charge) {
      const c = chargeText(a.charge)
      // Ringed charges read better in handwriting than bare signs next to letters.
      put(k, c, [right + letter * 0.22, a.q[1] - letter * 0.5], letter * 0.65)
    }
  })

  // Lone pairs: two dots in each free direction.
  if (lewis) {
    atoms.forEach((a, i) => {
      if (a.el === 'H' || a.el === 'C') return
      const ve = VALENCE[a.el]
      if (ve === undefined) return
      const pairs = Math.max(0, Math.floor((ve - a.order - a.h - a.charge) / 2))
      if (!pairs) return
      const taken = [
        ...a.nbrs.map((j) => unit(a.q, (atoms[j] as (typeof atoms)[0]).q)),
        ...(hPos[i] ?? []).map((q) => unit(a.q, q)),
      ]
      for (const d of freeDirections(taken, pairs, [0, -1])) {
        const c: Pt = [a.q[0] + d[0] * labelR * 1.05, a.q[1] + d[1] * labelR * 1.05]
        const n: Pt = [-d[1] * letter * 0.13, d[0] * letter * 0.13]
        pen.dot([c[0] + n[0], c[1] + n[1]], Math.max(0.7, letter * 0.045))
        pen.dot([c[0] - n[0], c[1] - n[1]], Math.max(0.7, letter * 0.045))
      }
    })
  }

  // Atom numbers, for talking about positions (and for curly arrows to refer to).
  if (o.numbers === true) {
    atoms.forEach((a) => {
      const taken = a.nbrs.map((j) => unit(a.q, (atoms[j] as (typeof atoms)[0]).q))
      const [d] = freeDirections(taken, 1, [1, -1]) as [Pt]
      const n = atoms.indexOf(a) + 1
      put(
        k,
        String(n),
        [a.q[0] + d[0] * letter * 0.85, a.q[1] + d[1] * letter * 0.85],
        letter * 0.5,
      )
    })
  }

  // Remember the atoms for curly arrows: "m1:3" (third atom in the SMILES) and "m1:O2".
  const id = text(o, 'id') || text(o, 'name') || 'm'
  const seen = new Map<string, number>()
  atoms.forEach((a, i) => {
    const r = labelled[i] ? labelR : letter * 0.25
    refs.set(`${id}:${i + 1}`, { p: a.q, r })
    const n = (seen.get(a.el) ?? 0) + 1
    seen.set(a.el, n)
    refs.set(`${id}:${a.el}${n}`, { p: a.q, r })
    if (n === 1) refs.set(`${id}:${a.el}`, { p: a.q, r })
  })

  const name = text(o, 'label') || text(o, 'caption')
  if (name) {
    const lowest = Math.max(...atoms.map((a) => a.q[1]))
    put(
      k,
      /\\|\$/.test(name) ? name.replace(/\$/g, '') : `\\text{${name}}`,
      [
        (Math.min(...atoms.map((a) => a.q[0])) + Math.max(...atoms.map((a) => a.q[0]))) / 2,
        // Below the hydrogens too, when every H is written out.
        lowest + letter * (full ? 2.2 : 1.3),
      ],
      letter * 0.85,
    )
  }
}

// ---------------------------------------------------------------------------
// Curly arrows (electron pushing)
// ---------------------------------------------------------------------------

function resolve(ref: unknown, refs: ChemRefs): { p: Pt; r: number; bond: boolean } | null {
  if (typeof ref !== 'string') return null
  const m = /^([^:]+):(.+)$/.exec(ref.trim())
  if (!m) return null
  const [, id, rest] = m as unknown as [string, string, string]
  const parts = rest.split('-')
  if (parts.length === 2) {
    const a = refs.get(`${id}:${parts[0]}`)
    const b = refs.get(`${id}:${parts[1]}`)
    return a && b ? { p: lerp(a.p, b.p, 0.5), r: 0, bond: true } : null
  }
  const a = refs.get(`${id}:${rest}`)
  return a ? { ...a, bond: false } : null
}

function drawCurly(o: DiagramItem, k: Sketch, refs: ChemRefs): void {
  const a = resolve(o.from, refs)
  const b = resolve(o.to, refs)
  if (!a || !b) return
  const bend = num(o.bend, 1) >= 0 ? 1 : -1
  const u = unit(a.p, b.p)
  const n: Pt = [u[1] * bend, -u[0] * bend]
  const d = dist(a.p, b.p)
  const lift = Math.max(k.size * 0.9, d * 0.45)
  // From a lone pair (beside the atom, on the outside of the curve) or from a bond's middle.
  const start: Pt = a.bond
    ? [a.p[0] + n[0] * 4, a.p[1] + n[1] * 4]
    : [a.p[0] + n[0] * (a.r + 3) + u[0] * 2, a.p[1] + n[1] * (a.r + 3) + u[1] * 2]
  // Into a bond's middle, or to the side of an atom facing where the arrow comes from.
  const end: Pt = b.bond
    ? [b.p[0] + n[0] * 4, b.p[1] + n[1] * 4]
    : d < k.size * 2.5
      ? [b.p[0] + n[0] * (b.r + 3), b.p[1] + n[1] * (b.r + 3)]
      : [b.p[0] - u[0] * (b.r + 3) + n[0] * 3, b.p[1] - u[1] * (b.r + 3) + n[1] * 3]
  const c: Pt = [(start[0] + end[0]) / 2 + n[0] * lift, (start[1] + end[1]) / 2 + n[1] * lift]
  const curve: Pt[] = []
  for (let i = 0; i <= 24; i++) {
    const t = i / 24
    const q = 1 - t
    curve.push([
      q * q * start[0] + 2 * q * t * c[0] + t * t * end[0],
      q * q * start[1] + 2 * q * t * c[1] + t * t * end[1],
    ])
  }
  k.pen.poly(curve)
  const tip = curve.at(-1) as Pt
  const back = curve.at(-4) as Pt
  const ang = Math.atan2(tip[1] - back[1], tip[0] - back[0])
  const hs = Math.max(4, k.size * 0.3)
  const wing = (s: number): Pt => [tip[0] - Math.cos(ang + s) * hs, tip[1] - Math.sin(ang + s) * hs]
  // A fish-hook (one electron) has half a head.
  if (o.fishhook === true || o.half === true) k.pen.poly([wing(0.45 * bend), tip])
  else k.pen.poly([wing(0.45), tip, wing(-0.45)])
}

// ---------------------------------------------------------------------------
// Reaction schemes: laid out left to right as molecules, formulas, + and arrows
// ---------------------------------------------------------------------------

type Species = { smiles?: string; formula?: string; coef?: string; name?: string; o: DiagramItem }

function species(v: unknown): Species | null {
  if (typeof v === 'string') return v.trim() ? { formula: v.trim(), o: { kind: 'ctext' } } : null
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : undefined)
  const coef = typeof o.coef === 'number' ? String(o.coef) : s('coef')
  if (s('smiles'))
    return {
      smiles: s('smiles'),
      coef,
      name: s('name') ?? s('label'),
      o: { kind: 'molecule', ...o },
    }
  const f = s('formula') ?? s('text') ?? s('ce')
  return f ? { formula: f, coef, name: s('name') ?? s('label'), o: { kind: 'ctext' } } : null
}

/** How wide LaTeX is, in bond lengths, at the scheme's letter size. */
function latexWidth(latex: string, letterPerBond: number): number {
  return layoutMath(latex, seeded(1)).w * letterPerBond
}

/** A reaction as molecules, formulas, plus signs and arrows, in world units (y up). */
export function expandReaction(o: DiagramItem): DiagramItem[] {
  const L = 0.55
  const steps: { arrow: string; above: string; below: string; to: Species[] }[] = []
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : v ? [v] : []).map(species).filter((x): x is Species => !!x)
  const start = list(o.reactants ?? o.from)
  if (Array.isArray(o.steps)) {
    for (const st of o.steps) {
      if (!st || typeof st !== 'object') continue
      const r = st as Record<string, unknown>
      steps.push({
        arrow: typeof r.arrow === 'string' ? r.arrow : '->',
        above: typeof r.above === 'string' ? r.above : '',
        below: typeof r.below === 'string' ? r.below : '',
        to: list(r.products ?? r.to),
      })
    }
  } else
    steps.push({
      arrow: typeof o.arrow === 'string' ? o.arrow : '->',
      above: typeof o.above === 'string' ? o.above : '',
      below: typeof o.below === 'string' ? o.below : '',
      to: list(o.products ?? o.to),
    })
  const out: DiagramItem[] = []
  let x = 0
  const size = num(o.size, 1)
  const place = (group: Species[]) => {
    group.forEach((sp, i) => {
      if (i > 0) {
        out.push({ kind: 'ctext', text: '+', latex: true, at: [x + 0.35, 0] })
        x += 0.7
      }
      if (sp.coef) {
        const w = latexWidth(sp.coef, L)
        out.push({ kind: 'ctext', text: sp.coef, latex: true, at: [x + w / 2, 0] })
        x += w + 0.15
      }
      if (sp.smiles) {
        const full = sp.o.hydrogens === 'all' || sp.o.lewis === true
        const m = drawnMolecule(sp.smiles, full, sp.o.layout)
        const b = m ? molBounds(m, full) : { x0: -0.5, x1: 0.5, y0: 0, y1: 0 }
        // Its left edge goes at x (the molecule's centre is its atoms' middle, not its box's).
        out.push({
          ...sp.o,
          kind: 'molecule',
          at: [x - b.x0 * size + 0.15, 0],
          size,
          label: sp.name,
        })
        x += (b.x1 - b.x0) * size + 0.3
      } else if (sp.formula) {
        const latex = ceToLatex(sp.formula)
        const w = latexWidth(latex, L)
        out.push({ kind: 'ctext', text: latex, latex: true, at: [x + w / 2, 0] })
        if (sp.name)
          out.push({
            kind: 'ctext',
            text: `\\text{${sp.name}}`,
            latex: true,
            at: [x + w / 2, -0.8],
            small: true,
          })
        x += w
      }
    })
  }
  place(start)
  for (const st of steps) {
    const above = st.above
      ? /[A-Z][a-z]?\d|\\/.test(st.above)
        ? ceToLatex(st.above)
        : `\\text{${st.above}}`
      : ''
    const below = st.below
      ? /[A-Z][a-z]?\d|\\/.test(st.below)
        ? ceToLatex(st.below)
        : `\\text{${st.below}}`
      : ''
    const w = Math.max(1.8, latexWidth(above, L * 0.72) + 0.6, latexWidth(below, L * 0.72) + 0.6)
    x += 0.3
    out.push({ kind: 'rarrow', from: [x, 0], to: [x + w, 0], arrow: st.arrow, above, below })
    x += w + 0.3
    place(st.to)
  }
  // Curly arrows and other items written inside the reaction come along.
  for (const extra of Array.isArray(o.arrows) ? o.arrows : []) {
    if (extra && typeof extra === 'object') out.push({ kind: 'curly', ...(extra as object) })
  }
  return out
}

function drawRarrow(o: DiagramItem, k: Sketch): void {
  const a = pt(o.from)
  const b = pt(o.to)
  if (!a || !b) return
  const p = k.map(a)
  const q = k.map(b)
  const { letter } = scales(k, o)
  const pen = k.pen
  const hs = Math.max(4, letter * 0.32)
  const kind = text(o, 'arrow') || '->'
  const g = letter * 0.14
  if (kind === '<=>' || kind === 'equilibrium') {
    pen.line([p[0], p[1] - g], [q[0], q[1] - g])
    pen.poly([
      [q[0] - hs, q[1] - g - hs * 0.7],
      [q[0], q[1] - g],
    ])
    pen.line([q[0], q[1] + g], [p[0], p[1] + g])
    pen.poly([
      [p[0] + hs, p[1] + g + hs * 0.7],
      [p[0], p[1] + g],
    ])
  } else {
    pen.line(p, q)
    pen.head(q, p, hs)
    if (kind === '<->') pen.head(p, q, hs)
  }
  const mid = lerp(p, q, 0.5)
  if (text(o, 'above'))
    put(k, text(o, 'above'), [mid[0], mid[1] - g - letter * 0.65], letter * 0.72)
  if (text(o, 'below'))
    put(k, text(o, 'below'), [mid[0], mid[1] + g + letter * 0.65], letter * 0.72)
}

function drawCtext(o: DiagramItem, k: Sketch): void {
  const p = pt(o.at)
  const s = text(o, 'text') || text(o, 'formula')
  if (!p || !s) return
  const { letter } = scales(k, o)
  const latex = o.latex === true ? s : ceToLatex(s)
  put(k, latex, k.map(p), letter * (o.small === true ? 0.75 : 1.05))
}

// ---------------------------------------------------------------------------
// Energy profiles
// ---------------------------------------------------------------------------

type Stage = { label: string; e: number; ts: boolean }

function stages(v: unknown): Stage[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((s): Stage[] => {
    if (Array.isArray(s)) return [{ label: String(s[0] ?? ''), e: num(s[1], 0), ts: s[2] === true }]
    if (!s || typeof s !== 'object') return []
    const o = s as Record<string, unknown>
    return [
      {
        label: typeof o.label === 'string' ? o.label : '',
        e: num(o.e ?? o.energy, 0),
        ts: o.ts === true || o.peak === true || /^(ts|transition)/i.test(String(o.label ?? '')),
      },
    ]
  })
}

function profileGeometry(o: DiagramItem) {
  const st = stages(o.stages ?? o.points ?? o.levels)
  const es = st.map((s) => s.e)
  const lo = Math.min(...es)
  const hi = Math.max(...es)
  const span = hi - lo || 1
  // Energies fill 0.6…4.6 units; stages sit 2.6 units apart.
  const y = (e: number) => 0.6 + ((e - lo) / span) * 4
  return { st, y, x: (i: number) => 1.2 + i * 2.6, w: 1.2 + (st.length - 1) * 2.6 + 1.6, lo, span }
}

function profileCurve(st: Stage[], y: (e: number) => number, x: (i: number) => number): Pt[] {
  const knots: Pt[] = []
  st.forEach((s, i) => {
    if (s.ts) knots.push([x(i), y(s.e)])
    else knots.push([x(i) - 0.45, y(s.e)], [x(i) + 0.45, y(s.e)])
  })
  return smooth(knots, false, 12)
}

function drawProfile(o: DiagramItem, k: Sketch): void {
  const { st, y, x, w } = profileGeometry(o)
  if (st.length < 2) return
  const pen = k.pen
  const { letter } = scales(k, o)
  const M = (p: Pt) => k.map(p)
  // Axes: energy up, reaction progress along.
  pen.line(M([0, 0]), M([0, 5.4]))
  pen.head(M([0, 5.4]), M([0, 0]), k.head)
  pen.line(M([0, 0]), M([w, 0]))
  pen.head(M([w, 0]), M([0, 0]), k.head)
  put(k, `\\text{${text(o, 'yLabel') || 'Energy'}}`, M([-0.25, 5.2]), letter * 0.8, 'r')
  put(k, `\\text{${text(o, 'xLabel') || 'Reaction progress'}}`, M([w / 2, -0.55]), letter * 0.8)
  pen.poly(profileCurve(st, y, x).map(M))
  const cat = Array.isArray(o.catalysed)
    ? o.catalysed
    : Array.isArray(o.catalyzed)
      ? o.catalyzed
      : null
  if (cat) {
    // The catalysed path: same start and end, lower peaks, dashed.
    let t = 0
    const low = st.map((s) => (s.ts ? { ...s, e: num(cat[t++], s.e) } : s))
    const c = profileCurve(low, y, x).map(M)
    for (let i = 0; i + 1 < c.length; i += 2) pen.line(c[i] as Pt, c[i + 1] as Pt)
  }
  st.forEach((s, i) => {
    if (!s.label) return
    const latex = /\\|\$/.test(s.label) ? s.label.replace(/\$/g, '') : ceToLatexMaybe(s.label)
    put(k, latex, M([x(i), y(s.e) + (s.ts ? 0.45 : 0.35)]), letter * 0.75)
  })
  const first = st[0] as Stage
  const last = st.at(-1) as Stage
  const peak = st.findIndex((s) => s.ts)
  if (o.ea !== false && peak > 0) {
    // Activation energy: from the starting level up to the first peak.
    const px = x(peak) - 0.15
    pen.line(M([x(0) + 0.45, y(first.e)]), M([px + 0.15, y(first.e)]), true)
    const a = M([px, y(first.e)])
    const b = M([px, y((st[peak] as Stage).e)])
    pen.line(a, b)
    pen.head(b, a, k.head * 0.8)
    pen.head(a, b, k.head * 0.8)
    put(k, 'E_a', [a[0] - letter * 0.5, (a[1] + b[1]) / 2], letter * 0.75, 'r')
  }
  if (o.dh !== false && Math.abs(last.e - first.e) > 1e-9) {
    const rx = x(st.length - 1) + 0.9
    pen.line(M([x(0) + 0.45, y(first.e)]), M([rx + 0.1, y(first.e)]), true)
    const a = M([rx, y(first.e)])
    const b = M([rx, y(last.e)])
    pen.line(a, b)
    pen.head(b, a, k.head * 0.8)
    put(k, '\\Delta H', [a[0] + letter * 0.3, (a[1] + b[1]) / 2], letter * 0.75, 'l')
  }
}

/** Stage names: formulas ("2NO2") as formulas, words as words. */
function ceToLatexMaybe(s: string): string {
  return /^[A-Z][A-Za-z0-9()+\-\s^]*$/.test(s) && /\d|[A-Z][a-z]?[A-Z]/.test(s)
    ? ceToLatex(s)
    : `\\text{${s}}`
}

// ---------------------------------------------------------------------------
// Orbital box diagrams (electron configurations)
// ---------------------------------------------------------------------------

const BOXES: Record<string, number> = { s: 1, p: 3, d: 5, f: 7 }

/** "[Ne] 3s2 3p4" → the core and the subshells with their electrons. */
export function subshells(src: string): { core: string; shells: { name: string; n: number }[] } {
  const core = /\[([A-Z][a-z]?)\]/.exec(src)?.[1] ?? ''
  const shells = [...src.matchAll(/(\d)([spdf])\s*\^?\{?(\d{1,2})\}?/g)].map((m) => ({
    name: `${m[1]}${m[2]}`,
    n: Number(m[3]),
  }))
  return { core, shells }
}

function boxesWidth(o: DiagramItem): number {
  const { core, shells } = subshells(String(o.config ?? o.configuration ?? o.text ?? ''))
  return (
    (core ? 1.8 : 0) + shells.reduce((s, sh) => s + (BOXES[sh.name[1] as string] ?? 1) + 0.6, 0)
  )
}

function drawBoxes(o: DiagramItem, k: Sketch): void {
  const { core, shells } = subshells(String(o.config ?? o.configuration ?? o.text ?? ''))
  if (!shells.length) return
  const at = pt(o.at) ?? [0, 0]
  const { letter } = scales(k, o)
  const pen = k.pen
  let x = at[0]
  if (core) {
    put(k, `[\\mathrm{${core}}]`, k.map([x + 0.8, at[1] + 0.5]), letter)
    x += 1.8
  }
  for (const sh of shells) {
    const n = BOXES[sh.name[1] as string] ?? 1
    const corners = [
      k.map([x, at[1]]),
      k.map([x + n, at[1]]),
      k.map([x + n, at[1] + 1]),
      k.map([x, at[1] + 1]),
    ]
    pen.poly(corners as Pt[], true)
    for (let i = 1; i < n; i++)
      pen.line(k.map([x + i, at[1]]), k.map([x + i, at[1] + 1]), false, true)
    // Hund's rule: one up in each box first, then pair them.
    for (let e = 0; e < Math.min(sh.n, n * 2); e++) {
      const box = e % n
      const down = e >= n
      const cx = x + box + (down ? 0.66 : 0.34)
      const a = k.map([cx, at[1] + (down ? 0.82 : 0.18)])
      const b = k.map([cx, at[1] + (down ? 0.18 : 0.82)])
      pen.line(a, b)
      // A half head, like a harpoon: spin up on the left, spin down on the right.
      const wing: Pt = down
        ? [b[0] + letter * 0.18, b[1] - letter * 0.22]
        : [b[0] - letter * 0.18, b[1] + letter * 0.22]
      pen.poly([wing, b])
    }
    put(k, sh.name, k.map([x + n / 2, at[1] - 0.45]), letter * 0.75)
    x += n + 0.6
  }
}

// ---------------------------------------------------------------------------
// Lab apparatus: outlines in their own units (bottom centre at 0,0, y up)
// ---------------------------------------------------------------------------

type Part = { paths: Pt[][]; closed?: boolean[]; inner?: Pt[]; h: number; w: number; top?: Pt }

const arc = (c: Pt, r: number, a0: number, a1: number, n = 18): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180
    return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] as Pt
  })

/** A vessel from its right-hand profile (bottom to top), mirrored. */
function vessel(profile: Pt[], lip = 0.08): Part {
  const right = profile
  const left = profile.map(([x, y]) => [-x, y] as Pt).reverse()
  const top = profile.at(-1) as Pt
  return {
    paths: [
      [...left, ...right],
      [
        [top[0], top[1]],
        [top[0] + lip, top[1] + lip * 0.6],
      ],
      [
        [-top[0], top[1]],
        [-top[0] - lip, top[1] + lip * 0.6],
      ],
    ],
    inner: [...left, ...right],
    h: top[1],
    w: Math.max(...profile.map((p) => p[0])) * 2,
    top: [0, top[1]],
  }
}

const APPARATUS: Record<string, () => Part> = {
  beaker: () => {
    const p = vessel([
      [0.8, 0],
      [0.8, 1.7],
    ])
    // Spout.
    p.paths.push([
      [-0.8, 1.7],
      [-0.95, 1.82],
    ])
    for (let i = 1; i <= 3; i++)
      p.paths.push([
        [0.8, i * 0.4],
        [0.6, i * 0.4],
      ])
    return p
  },
  conical_flask: () =>
    vessel([
      [0.95, 0],
      [0.98, 0.08],
      [0.3, 1.45],
      [0.28, 2.1],
    ]),
  round_flask: () => {
    const body = arc([0, 0.75], 0.75, -70, 250, 30).reverse()
    const a = body[0] as Pt
    const b = body.at(-1) as Pt
    return {
      paths: [[[-0.2, 2.1], [-0.2, a[1]], ...body.slice(1, -1), [0.2, b[1]], [0.2, 2.1]] as Pt[]],
      inner: arc([0, 0.75], 0.74, 0, 360, 30),
      h: 2.1,
      w: 1.5,
      top: [0, 2.1],
    }
  },
  test_tube: () => {
    const bottom = arc([0, 0.22], 0.22, 180, 360, 12)
    const path: Pt[] = [[-0.22, 2], ...bottom, [0.22, 2]]
    return { paths: [path], inner: path, h: 2, w: 0.44, top: [0, 2] }
  },
  boiling_tube: () => {
    const bottom = arc([0, 0.3], 0.3, 180, 360, 12)
    const path: Pt[] = [[-0.3, 2.4], ...bottom, [0.3, 2.4]]
    return { paths: [path], inner: path, h: 2.4, w: 0.6, top: [0, 2.4] }
  },
  measuring_cylinder: () => {
    const p = vessel([
      [0.3, 0.1],
      [0.3, 2.8],
    ])
    p.paths.push([
      [-0.6, 0],
      [0.6, 0],
      [0.6, 0.1],
      [-0.6, 0.1],
      [-0.6, 0],
    ])
    for (let i = 1; i <= 9; i++)
      p.paths.push([
        [-0.3, 0.1 + i * 0.27],
        [i % 5 === 0 ? -0.05 : -0.15, 0.1 + i * 0.27],
      ])
    return p
  },
  burette: () => {
    const tube: Pt[] = [
      [-0.12, 4],
      [-0.12, 0.7],
      [-0.04, 0.4],
      [-0.04, 0],
      [0.04, 0],
      [0.04, 0.4],
      [0.12, 0.7],
      [0.12, 4],
    ]
    const paths: Pt[][] = [
      tube,
      [
        [-0.25, 0.55],
        [0.25, 0.55],
      ],
      [
        [0.25, 0.45],
        [0.25, 0.65],
      ],
    ]
    for (let i = 1; i <= 12; i++)
      paths.push([
        [-0.12, 0.8 + i * 0.25],
        [i % 5 === 0 ? 0.04 : -0.02, 0.8 + i * 0.25],
      ])
    return { paths, inner: tube, h: 4, w: 0.5, top: [0, 4] }
  },
  pipette: () => {
    const bulb = arc([0, 1.6], 0.22, -70, 250, 16).reverse()
    return {
      paths: [
        [
          [-0.05, 3],
          [-0.05, 1.82],
          ...bulb.slice(1, -1),
          [-0.05, 1.38],
          [-0.05, 0.2],
          [0, 0],
          [0.05, 0.2],
          [0.05, 1.38],
          [0.05, 3],
        ] as Pt[],
      ],
      h: 3,
      w: 0.44,
    }
  },
  funnel: () => ({
    paths: [
      [
        [-0.8, 1.6],
        [-0.08, 0.7],
        [-0.08, 0],
      ],
      [
        [0.8, 1.6],
        [0.08, 0.7],
        [0.08, 0],
      ],
    ],
    h: 1.6,
    w: 1.6,
  }),
  separating_funnel: () => {
    const body = smoothPts([
      [-0.1, 0.9],
      [-0.45, 1.5],
      [-0.5, 2.1],
      [-0.12, 2.6],
    ])
    return {
      paths: [
        [
          [-0.12, 2.9],
          ...body
            .slice()
            .reverse()
            .map(([x, y]) => [x, y] as Pt),
          [-0.06, 0.9],
          [-0.06, 0],
        ],
        [
          [0.12, 2.9],
          ...body
            .slice()
            .reverse()
            .map(([x, y]) => [-x, y] as Pt),
          [0.06, 0.9],
          [0.06, 0],
        ],
        [
          [-0.22, 0.75],
          [0.22, 0.75],
        ],
      ],
      inner: [...body, ...body.map(([x, y]) => [-x, y] as Pt).reverse()],
      h: 2.9,
      w: 1,
    }
  },
  condenser: () => ({
    // Drawn upright; tilt it with "angle".
    paths: [
      [
        [-0.1, -0.3],
        [-0.1, 3.3],
      ],
      [
        [0.1, -0.3],
        [0.1, 3.3],
      ],
      [
        [-0.32, 0.3],
        [-0.32, 2.7],
        [-0.1, 2.9],
      ],
      [
        [0.32, 0.3],
        [0.32, 2.7],
        [0.1, 2.9],
      ],
      [
        [-0.32, 0.3],
        [-0.1, 0.1],
      ],
      [
        [0.32, 0.3],
        [0.1, 0.1],
      ],
      [
        [0.32, 0.5],
        [0.6, 0.5],
      ],
      [
        [0.32, 0.65],
        [0.6, 0.65],
      ],
      [
        [-0.32, 2.35],
        [-0.6, 2.35],
      ],
      [
        [-0.32, 2.5],
        [-0.6, 2.5],
      ],
    ],
    h: 3.3,
    w: 1.2,
  }),
  bunsen: () => ({
    paths: [
      [
        [-0.6, 0],
        [0.6, 0],
        [0.6, 0.15],
        [-0.6, 0.15],
        [-0.6, 0],
      ],
      [
        [-0.12, 0.15],
        [-0.12, 1.6],
      ],
      [
        [0.12, 0.15],
        [0.12, 1.6],
      ],
      [
        [-0.12, 0.45],
        [-0.45, 0.45],
      ],
      smoothPts([
        [0, 1.62],
        [-0.18, 1.9],
        [-0.05, 2.25],
        [0.02, 2.45],
        [0.16, 2.1],
        [0, 1.62],
      ]),
    ],
    h: 2.45,
    w: 1.2,
    top: [0, 2.45],
  }),
  tripod: () => ({
    paths: [
      [
        [-0.9, 1.6],
        [0.9, 1.6],
      ],
      [
        [-0.75, 1.6],
        [-0.95, 0],
      ],
      [
        [0.75, 1.6],
        [0.95, 0],
      ],
      [
        [0, 1.6],
        [0.08, 0.1],
      ],
    ],
    h: 1.6,
    w: 1.9,
    top: [0, 1.6],
  }),
  gauze: () => {
    const paths: Pt[][] = [
      [
        [-1, 0],
        [1, 0],
      ],
      [
        [-1, 0.06],
        [1, 0.06],
      ],
    ]
    for (let i = -4; i <= 4; i++)
      paths.push([
        [i * 0.22 - 0.06, 0],
        [i * 0.22 + 0.06, 0.06],
      ])
    return { paths, h: 0.06, w: 2, top: [0, 0.06] }
  },
  thermometer: () => {
    const bulb = arc([0, 0.12], 0.12, 110, 430, 14)
    const paths: Pt[][] = [
      [[-0.05, 2.6], [-0.05, 0.23], ...bulb.slice(1, -1), [0.05, 0.23], [0.05, 2.6], [-0.05, 2.6]],
    ]
    for (let i = 1; i <= 8; i++)
      paths.push([
        [0.05, 0.4 + i * 0.25],
        [0.15, 0.4 + i * 0.25],
      ])
    return { paths, h: 2.6, w: 0.3 }
  },
  stand: () => ({
    paths: [
      [
        [-0.9, 0],
        [0.9, 0],
        [0.9, 0.15],
        [-0.9, 0.15],
        [-0.9, 0],
      ],
      [
        [-0.6, 0.15],
        [-0.6, 4],
      ],
      [
        [-0.5, 0.15],
        [-0.5, 4],
      ],
      [
        [-0.68, 2.6],
        [-0.42, 2.6],
        [-0.42, 2.85],
        [-0.68, 2.85],
        [-0.68, 2.6],
      ],
      [
        [-0.42, 2.72],
        [0.1, 2.72],
      ],
    ],
    h: 4,
    w: 1.8,
  }),
  gas_jar: () => {
    const p = vessel([
      [0.5, 0],
      [0.5, 2.2],
    ])
    p.paths.push([
      [-0.65, 2.25],
      [0.65, 2.25],
    ])
    return p
  },
  evaporating_dish: () => {
    const bowl = arc([0, 0.75], 0.85, 205, 335, 16)
    return { paths: [bowl], inner: bowl, h: 0.4, w: 1.6, top: [0, 0.4] }
  },
  crucible: () => {
    const p = vessel([
      [0.3, 0],
      [0.45, 0.7],
    ])
    p.paths.push(
      [
        [-0.55, 0.78],
        [0.55, 0.78],
      ],
      [
        [-0.15, 0.78],
        [-0.1, 0.9],
        [0.1, 0.9],
        [0.15, 0.78],
      ],
    )
    return p
  },
  trough: () => {
    const p = vessel([
      [1.4, 0],
      [1.4, 0.9],
    ])
    return p
  },
  watch_glass: () => {
    const g = arc([0, 0.9], 0.9, 235, 305, 12)
    return { paths: [g], h: 0.2, w: 1.1 }
  },
}

function smoothPts(points: Pt[]): Pt[] {
  return smooth(points, false, 6)
}

const APPARATUS_ALIASES: Record<string, string> = {
  flask: 'conical_flask',
  erlenmeyer: 'conical_flask',
  conical: 'conical_flask',
  round_bottom_flask: 'round_flask',
  round_bottomed_flask: 'round_flask',
  distillation_flask: 'round_flask',
  bunsen_burner: 'bunsen',
  burner: 'bunsen',
  cylinder: 'measuring_cylinder',
  graduated_cylinder: 'measuring_cylinder',
  liebig_condenser: 'condenser',
  retort_stand: 'stand',
  clamp_stand: 'stand',
  wire_gauze: 'gauze',
  tube: 'test_tube',
}

export const APPARATUS_NAMES = Object.keys(APPARATUS)

const apparatusPart = (name: string): Part | null => {
  const key = name.toLowerCase().replace(/[\s-]+/g, '_')
  const f = APPARATUS[key] ?? APPARATUS[APPARATUS_ALIASES[key] ?? '']
  return f ? f() : null
}

function placeLocal(o: DiagramItem): (p: Pt) => Pt {
  const at = pt(o.at) ?? [0, 0]
  const s = num(o.size ?? o.scale, 1)
  const a = (num(o.angle ?? o.rotate, 0) * Math.PI) / 180
  return ([x, y]) => [
    at[0] + (x * Math.cos(a) - y * Math.sin(a)) * s,
    at[1] + (x * Math.sin(a) + y * Math.cos(a)) * s,
  ]
}

function drawApparatus(o: DiagramItem, k: Sketch): void {
  const part = apparatusPart(text(o, 'name') || text(o, 'type'))
  if (!part) return
  const local = placeLocal(o)
  for (const path of part.paths) k.pen.poly(path.map((p) => k.map(local(p))))
  const level = num(o.liquid ?? o.fill, 0)
  if (level > 0 && part.inner) {
    // A liquid: its surface, and light hatching below it inside the vessel.
    const poly = part.inner
    const ys = poly.map((p) => p[1])
    const y0 = Math.min(...ys)
    const yl = y0 + (Math.max(...ys) - y0) * Math.min(1, level)
    const xsAt = (y: number) => {
      const xs: number[] = []
      for (let i = 0; i + 1 < poly.length; i++) {
        const [a, b] = [poly[i] as Pt, poly[i + 1] as Pt]
        if ((a[1] - y) * (b[1] - y) <= 0 && a[1] !== b[1])
          xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]))
      }
      return xs.sort((p, q) => p - q)
    }
    const surf = xsAt(yl)
    if (surf.length >= 2)
      k.pen.line(k.map(local([surf[0] as number, yl])), k.map(local([surf.at(-1) as number, yl])))
    k.pen.faint(() => {
      const step = 0.13
      for (let y = y0 + step / 2; y < yl; y += step) {
        const xs = xsAt(y)
        if (xs.length >= 2)
          k.pen.line(
            k.map(local([(xs[0] as number) + 0.04, y])),
            k.map(local([(xs.at(-1) as number) - 0.04, y])),
            false,
            true,
          )
      }
    })
  }
  const label = text(o, 'label')
  if (label) {
    const { letter } = scales(k, { kind: 'x' })
    const side = local([part.w / 2 + 0.25, part.h * 0.6])
    put(k, `\\text{${label}}`, k.map(side), letter * 0.8, 'l')
  }
}

/** Ready-made set-ups as apparatus placed together. */
export function expandSetup(o: DiagramItem): DiagramItem[] {
  const name = (text(o, 'name') || text(o, 'type')).toLowerCase()
  const A = (n: string, at: Pt, extra: Record<string, unknown> = {}): DiagramItem => ({
    kind: 'apparatus',
    name: n,
    at,
    ...extra,
  })
  const names = o.labels !== false
  const out: DiagramItem[] = []
  const call: { at: Pt; text: string }[] = []
  if (/distil/.test(name)) {
    out.push(
      A('bunsen', [0, 0]),
      A('tripod', [0, 0]),
      A('gauze', [0, 1.6]),
      A('round_flask', [0, 1.66], { liquid: 0.45 }),
    )
    out.push(A('thermometer', [0, 3.0]))
    out.push(A('condenser', [0.6, 3.25], { angle: -115 }))
    out.push(A('conical_flask', [4.0, 0.0], { liquid: 0.2 }))
    out.push({
      kind: 'polyline',
      points: [
        [0.2, 3.75],
        [0.45, 3.75],
        [0.6, 3.25],
      ],
    })
    call.push(
      { at: [0, 4.5], text: 'thermometer' },
      { at: [2.2, 2.55], text: 'condenser' },
      { at: [0.3, 2.1], text: 'flask' },
      { at: [0.1, 0.8], text: 'heat' },
      { at: [4.3, 0.5], text: 'distillate' },
      { at: [3.0, 2.8], text: 'water in' },
      { at: [0.8, 2.5], text: 'water out' },
    )
  } else if (/titrat/.test(name)) {
    out.push(
      A('stand', [0, 0]),
      A('burette', [0.25, 1.9], { liquid: 0.8 }),
      A('conical_flask', [0.25, 0.15], { liquid: 0.25 }),
    )
    call.push(
      { at: [0.25, 4.5], text: 'burette' },
      { at: [0.25, 0.4], text: 'conical flask' },
      { at: [-0.55, 1.2], text: 'stand' },
    )
  } else if (/water|gas/.test(name)) {
    out.push(
      A('conical_flask', [0, 0], { liquid: 0.3 }),
      A('trough', [3.4, 0], { liquid: 0.75 }),
      A('gas_jar', [3.8, 2.4], { angle: 180 }),
    )
    out.push({
      kind: 'polyline',
      points: [
        [0, 2.1],
        [0, 2.6],
        [2.4, 2.6],
        [2.4, 0.3],
        [3.8, 0.3],
        [3.8, 0.7],
      ],
    })
    call.push(
      { at: [0, 0.4], text: 'reactants' },
      { at: [2.4, 1.6], text: 'delivery tube' },
      { at: [3.8, 1.6], text: 'gas jar' },
      { at: [4.6, 0.4], text: 'water' },
    )
  } else if (/filt/.test(name)) {
    out.push(A('conical_flask', [0, 0], { liquid: 0.2 }), A('funnel', [0, 1.75]))
    out.push({
      kind: 'polyline',
      points: [
        [-0.65, 3.15],
        [0, 2.4],
        [0.65, 3.15],
      ],
    })
    call.push(
      { at: [-0.5, 3.0], text: 'filter paper' },
      { at: [0.4, 3.2], text: 'funnel' },
      { at: [0, 0.3], text: 'filtrate' },
    )
  } else {
    // Heating: a beaker on a tripod and gauze over a Bunsen burner.
    out.push(
      A('bunsen', [0, 0]),
      A('tripod', [0, 0]),
      A('gauze', [0, 1.6]),
      A('beaker', [0, 1.66], { liquid: 0.5 }),
    )
    call.push(
      { at: [0.5, 2.6], text: 'beaker' },
      { at: [-0.8, 1.6], text: 'gauze' },
      { at: [0.85, 0.8], text: 'tripod' },
      { at: [0, 1.0], text: 'Bunsen burner' },
    )
  }
  if (names) out.push({ kind: 'callouts', labels: call })
  return out
}

// ---------------------------------------------------------------------------
// Crystal lattices, Newman, Fischer and chair projections
// ---------------------------------------------------------------------------

function drawLattice(o: DiagramItem, k: Sketch): void {
  const type = (text(o, 'type') || 'sc').toLowerCase()
  const s = 2
  const at = pt(o.at) ?? [0, 0]
  const P = (x: number, y: number, z: number) => {
    const q = project([x * s, y * s, z * s])
    return k.map([at[0] + q[0], at[1] + q[1]])
  }
  const corners = [0, 1].flatMap((x) =>
    [0, 1].flatMap((y) => [0, 1].map((z) => [x, y, z] as [number, number, number])),
  )
  // The three edges at the back corner (x = 0 is toward us, so x = 1, y = 0, z = 0 is behind).
  for (const a of corners) {
    for (const b of corners) {
      const diff = a.map((v, i) => Math.abs(v - (b[i] as number)))
      if (diff.reduce((p, q) => p + q, 0) !== 1 || a.join() > b.join()) continue
      const hidden = [a, b].some((c) => c[0] === 1 && c[1] === 0 && c[2] === 0)
      k.pen.line(P(...a), P(...b), hidden, true)
    }
  }
  const r = Math.max(2.5, Math.abs(k.sx) * 0.22)
  const atom = (c: [number, number, number], big = true) =>
    k.pen.ellipse(P(...c), big ? r : r * 0.65, big ? r : r * 0.65)
  for (const c of corners) atom(c)
  if (type === 'bcc') atom([0.5, 0.5, 0.5])
  if (type === 'fcc' || type === 'ccp')
    for (const c of [
      [0.5, 0.5, 0],
      [0.5, 0.5, 1],
      [0.5, 0, 0.5],
      [0.5, 1, 0.5],
      [0, 0.5, 0.5],
      [1, 0.5, 0.5],
    ] as [number, number, number][])
      atom(c)
  if (type === 'nacl' || type === 'rock_salt') {
    for (let x = 0; x <= 2; x++)
      for (let y = 0; y <= 2; y++)
        for (let z = 0; z <= 2; z++) {
          if ((x + y + z) % 2 === 0 && !(x % 2 === 0 && y % 2 === 0 && z % 2 === 0))
            atom([x / 2, y / 2, z / 2])
          if ((x + y + z) % 2 === 1) atom([x / 2, y / 2, z / 2], false)
        }
  }
}

function drawNewman(o: DiagramItem, k: Sketch): void {
  const at = pt(o.at) ?? [0, 0]
  const c = k.map(at)
  const R = Math.abs(k.sx) * 0.9
  const L = R * 1.9
  const { letter } = scales(k, o)
  const front = (Array.isArray(o.front) ? o.front : ['H', 'H', 'H']).map(String)
  const back = (Array.isArray(o.back) ? o.back : ['H', 'H', 'H']).map(String)
  const twist = num(o.angle ?? o.dihedral, 60)
  k.pen.ellipse(c, R, R)
  front.slice(0, 3).forEach((g, i) => {
    const a = ((90 + i * 120) * Math.PI) / 180
    const e: Pt = [c[0] + Math.cos(a) * L, c[1] - Math.sin(a) * L]
    k.pen.line(c, e, false, true)
    put(
      k,
      ceToLatexMaybe(g),
      [c[0] + Math.cos(a) * (L + letter * 0.7), c[1] - Math.sin(a) * (L + letter * 0.7)],
      letter,
    )
  })
  back.slice(0, 3).forEach((g, i) => {
    const a = ((90 + twist + i * 120) * Math.PI) / 180
    const s: Pt = [c[0] + Math.cos(a) * R, c[1] - Math.sin(a) * R]
    const e: Pt = [c[0] + Math.cos(a) * L, c[1] - Math.sin(a) * L]
    k.pen.line(s, e, false, true)
    put(
      k,
      ceToLatexMaybe(g),
      [c[0] + Math.cos(a) * (L + letter * 0.7), c[1] - Math.sin(a) * (L + letter * 0.7)],
      letter,
    )
  })
}

function drawFischer(o: DiagramItem, k: Sketch): void {
  const at = pt(o.at) ?? [0, 0]
  const rows = (Array.isArray(o.rows) ? o.rows : []).filter(Array.isArray) as unknown[][]
  const { letter } = scales(k, o)
  const n = rows.length
  const M = (x: number, y: number) => k.map([at[0] + x, at[1] + y])
  const top = text(o, 'top')
  const bottom = text(o, 'bottom')
  k.pen.line(M(0, n * 0.5 + 0.3), M(0, -n * 0.5 - 0.3), false, true)
  rows.forEach((r, i) => {
    const y = (n - 1) * 0.5 - i
    k.pen.line(M(-0.9, y), M(0.9, y), false, true)
    put(k, ceToLatexMaybe(String(r[0] ?? '')), M(-1.0, y), letter, 'r')
    put(k, ceToLatexMaybe(String(r[1] ?? '')), M(1.0, y), letter, 'l')
  })
  if (top) put(k, ceToLatexMaybe(top), M(0, n * 0.5 + 0.7), letter)
  if (bottom) put(k, ceToLatexMaybe(bottom), M(0, -n * 0.5 - 0.7), letter)
}

/** Chair cyclohexane: ring carbons 1–6, axial bonds alternating down/up from C1. */
// A chair seen from a little above (a hexagon with alternating heights, projected): the
// left tip is the footrest, the right tip the headrest, opposite bonds parallel.
const CHAIR: Pt[] = [
  [0, -0.24],
  [0.6, -0.12],
  [1.8, -0.6],
  [2.4, 0.24],
  [1.8, 0.12],
  [0.6, 0.6],
]

function drawChair(o: DiagramItem, k: Sketch): void {
  const at = pt(o.at) ?? [0, 0]
  const M = (p: Pt) => k.map([at[0] + p[0] - 1.2, at[1] + p[1]])
  const { letter } = scales(k, o)
  for (let i = 0; i < 6; i++)
    k.pen.line(M(CHAIR[i] as Pt), M(CHAIR[(i + 1) % 6] as Pt), false, true)
  const c: Pt = [1.2, 0]
  const subs = Array.isArray(o.substituents) ? o.substituents : []
  for (const s of subs) {
    if (!s || typeof s !== 'object') continue
    const r = s as Record<string, unknown>
    const i = Math.round(num(r.at ?? r.carbon, 1)) - 1
    const p = CHAIR[((i % 6) + 6) % 6] as Pt
    const up = i % 2 === 1
    for (const [key, axial] of [
      ['axial', true],
      ['equatorial', false],
    ] as const) {
      const g = r[key]
      if (typeof g !== 'string') continue
      let d: Pt
      if (axial) d = [0, up ? 0.9 : -0.9]
      else {
        const out = unit(c, p)
        d = [out[0] * 0.85, out[1] * 0.4 + (up ? -0.3 : 0.3)]
      }
      const e: Pt = [p[0] + d[0], p[1] + d[1]]
      k.pen.line(M(p), M(e), false, true)
      const u = unit(M(p), M(e))
      const q = M(e)
      put(
        k,
        ceToLatexMaybe(g),
        [q[0] + u[0] * letter * 0.7, q[1] + u[1] * letter * 0.7],
        letter * 0.85,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Extents and dispatch
// ---------------------------------------------------------------------------

export function chemExtent(o: DiagramItem): Pt[] {
  const at = pt(o.at) ?? pt(o.center) ?? [0, 0]
  const s = num(o.size ?? o.scale, 1)
  switch (o.kind) {
    case 'molecule': {
      const full = o.lewis === true || o.hydrogens === 'all'
      const m = drawnMolecule(text(o, 'smiles') || text(o, 'structure'), full, o.layout)
      if (!m) return []
      const b = molBounds(m, full)
      const below = text(o, 'label') ? 0.9 : 0
      // Molecule y runs down; the world's runs up.
      return [
        [at[0] + b.x0 * s - 0.2, at[1] - b.y1 * s - 0.2 - below],
        [at[0] + b.x1 * s + 0.2, at[1] - b.y0 * s + 0.2],
      ]
    }
    case 'ctext':
      return [at]
    case 'rarrow':
      return [pt(o.from), pt(o.to)]
        .filter((p): p is Pt => !!p)
        .flatMap(
          (p) =>
            [
              [p[0], p[1] - 0.8],
              [p[0], p[1] + 0.8],
            ] as Pt[],
        )
    case 'energy_profile': {
      const g = profileGeometry(o)
      return [
        [-1.6, -0.9],
        [g.w + 1.2, 5.6],
      ]
    }
    case 'orbital_boxes':
      return [
        [at[0], at[1] - 0.9],
        [at[0] + boxesWidth(o), at[1] + 1.2],
      ]
    case 'apparatus': {
      const part = apparatusPart(text(o, 'name') || text(o, 'type'))
      if (!part) return []
      const local = placeLocal(o)
      return [
        local([-part.w / 2, 0]),
        local([part.w / 2, part.h]),
        local([-part.w / 2, part.h]),
        local([part.w / 2, 0]),
      ]
    }
    case 'lattice':
      return [project([0, 0, 0]), project([2, 2, 2]), project([2, 0, 0]), project([0, 2, 2])].map(
        (p) => [at[0] + p[0], at[1] + p[1]],
      )
    case 'newman':
      return [
        [at[0] - 2.4, at[1] - 2.4],
        [at[0] + 2.4, at[1] + 2.4],
      ]
    case 'fischer': {
      const n = Array.isArray(o.rows) ? o.rows.length : 1
      return [
        [at[0] - 2.2, at[1] - n * 0.5 - 1],
        [at[0] + 2.2, at[1] + n * 0.5 + 1],
      ]
    }
    case 'chair':
      return [
        [at[0] - 2.4, at[1] - 1.8],
        [at[0] + 2.4, at[1] + 1.8],
      ]
    default:
      return []
  }
}

export function drawChem(o: DiagramItem, k: Sketch, refs: ChemRefs): void {
  switch (o.kind) {
    case 'molecule':
      drawMolecule(o, k, refs)
      return
    case 'curly':
      drawCurly(o, k, refs)
      return
    case 'ctext':
      drawCtext(o, k)
      return
    case 'rarrow':
      drawRarrow(o, k)
      return
    case 'energy_profile':
      drawProfile(o, k)
      return
    case 'orbital_boxes':
      drawBoxes(o, k)
      return
    case 'apparatus':
      drawApparatus(o, k)
      return
    case 'lattice':
      drawLattice(o, k)
      return
    case 'newman':
      drawNewman(o, k)
      return
    case 'fischer':
      drawFischer(o, k)
      return
    case 'chair':
      drawChair(o, k)
      return
  }
}

/** Reactions and set-ups become the items they are made of; curly arrows go last. */
export function expandChem(items: readonly DiagramItem[]): DiagramItem[] {
  const out = items.flatMap((o) =>
    o.kind === 'reaction' ? expandReaction(o) : o.kind === 'setup' ? expandSetup(o) : [o],
  )
  return [...out.filter((o) => o.kind !== 'curly'), ...out.filter((o) => o.kind === 'curly')]
}
