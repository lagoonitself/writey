import {
  type DiagramItem,
  deg,
  dist,
  lerp,
  num,
  type Pt,
  pt,
  quad,
  type Sketch,
  text,
  unit,
} from './sketch'

// Ray optics. The model gives only the physics (element, focal length, object), and Writey
// works the rays out itself, the way the ray-optics simulator treats ideal lenses and
// mirrors: thin elements that obey 1/v − 1/u = 1/f. A mirror is traced as the matching lens
// and the light after it folded back, so one tracer serves both. Prisms, slabs and single
// surfaces use Snell's law, with total internal reflection.

export const OPTICS_KINDS: Record<string, string> = {
  optics: 'optics',
  ray_diagram: 'optics',
  raydiagram: 'optics',
  rays: 'optics',
  microscope: 'optics',
  telescope: 'optics',
  lens: 'lens',
  mirror: 'mirror',
  prism: 'prism',
  slab: 'slab',
  glass_slab: 'slab',
  refraction: 'refraction',
  reflection: 'refraction',
  interface: 'refraction',
}

type El = { mirror: boolean; f: number; x: number; label: string }
type Img = { x: number; h: number; virtual: boolean; far: boolean }

/** Reads one optical element. Converging = positive focal length (convex lens, concave mirror). */
function element(raw: unknown, kind?: string): El | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const type =
    `${kind ?? ''} ${typeof o.type === 'string' ? o.type : ''} ${typeof o.kind === 'string' ? o.kind : ''}`.toLowerCase()
  const mirror = type.includes('mirror')
  const fSigned = num(o.f ?? o.focal ?? o.focal_length ?? o.focalLength, 0)
  const f0 = Math.abs(fSigned)
  if (!f0) return null
  // Convex lenses and concave mirrors converge; concave lenses and convex mirrors diverge.
  const converging = /converg/.test(type) || (mirror ? /concave/ : /convex/).test(type)
  const diverging = /diverg/.test(type) || (mirror ? /convex/ : /concave/).test(type)
  const f = converging ? f0 : diverging ? -f0 : fSigned
  const at = pt(o.at)
  return {
    mirror,
    f,
    x: num(o.x ?? o.position ?? o.pos, at ? at[0] : 0),
    label: typeof o.label === 'string' ? o.label : '',
  }
}

type Obj = {
  x: number
  h: number
  label: string
  /** A distant object (stars, telescopes): parallel rays coming in at this slope. */
  slope?: number
}

const INF = /^-?\s*(inf|infinity|∞|far|distant)/i

function object(raw: unknown): Obj | null {
  if (typeof raw === 'string' && INF.test(raw)) return { x: Number.NaN, h: 1, label: '', slope: 0 }
  if (Array.isArray(raw)) {
    const p = pt(raw)
    return p ? { x: p[0], h: p[1], label: '' } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const label = typeof o.label === 'string' ? o.label : ''
  const where = o.x ?? o.u ?? o.position ?? o.pos ?? o.at
  if ((typeof where === 'string' && INF.test(where)) || o.infinity === true)
    return { x: Number.NaN, h: 1, label, slope: -Math.tan(deg(num(o.angle, 0))) }
  const at = pt(o.at)
  const x = num(o.x ?? o.u ?? o.position ?? o.pos, at ? at[0] : Number.NaN)
  const h = num(o.h ?? o.height, at?.[1] ? at[1] : 1)
  return Number.isFinite(x) ? { x, h, label } : null
}

/** The elements and object of a ray diagram, from either form. */
function setup(o: DiagramItem): { els: El[]; obj: Obj | null } {
  let els: El[]
  if (Array.isArray(o.elements)) els = o.elements.map((e) => element(e)).filter((e): e is El => !!e)
  else {
    const e = element(o, o.kind)
    els = e ? [e] : []
  }
  // Light goes left to right; a mirror ends the chain.
  els.sort((a, b) => a.x - b.x)
  const m = els.findIndex((e) => e.mirror)
  if (m >= 0) els = els.slice(0, m + 1)
  const obj = object(o.object)
  // An object many focal lengths away sends in (nearly) parallel rays: draw it as textbooks
  // do, rays coming in at a small angle, instead of a far-off arrow that shrinks everything.
  const first = els[0]
  if (obj && first && obj.slope === undefined && first.x - obj.x > 8 * Math.abs(first.f)) {
    obj.slope = -Math.abs(obj.h) / (first.x - obj.x)
  }
  if (obj?.slope !== undefined && first) {
    // Steep enough to see, never so steep the image runs off the frame.
    const t = Math.min(0.4, Math.max(0.18, Math.abs(obj.slope)))
    obj.slope = obj.slope > 0 ? t : -t
    obj.x = first.x - 1.6 * Math.abs(first.f)
    return { els, obj }
  }
  // In an instrument the object sits just beyond the objective's focus (a model often puts
  // it at F, which sends the image to infinity and ends the trace at the first lens).
  if (obj && first && els.length > 1 && first.f > 0 && first.x - obj.x < first.f * 1.1) {
    obj.x = first.x - first.f * 1.2
  }
  // Real objects are tiny next to focal lengths. Images scale with the object's height and
  // their positions don't depend on it, so a taller object keeps the diagram exact and readable.
  if (obj && els.length) {
    const fmin = Math.min(...els.map((e) => Math.abs(e.f)))
    const h = Math.max(Math.abs(obj.h), fmin * 0.35)
    obj.h = obj.h < 0 ? -h : h
  }
  return { els, obj }
}

type Rule = { m: number; ys: number; ye: number; label: string }

/**
 * The textbook ray rules for one element with no object: a ray parallel to the axis, one
 * through (or toward) F, one through the optical centre or C, one at the pole.
 */
function rules(o: DiagramItem, el: El): Rule[] {
  const list = Array.isArray(o.rays) ? o.rays : typeof o.rays === 'string' ? [o.rays] : []
  const f = el.f
  const xs = el.x - 2.2 * Math.abs(f)
  const span = el.x - xs
  return list.flatMap((r, i): Rule[] => {
    const spec = (typeof r === 'string' ? { type: r } : (r ?? {})) as Record<string, unknown>
    const type = String(spec.type ?? spec.kind ?? 'parallel').toLowerCase()
    const h = num(spec.h ?? spec.height, Math.abs(f) * (0.45 - i * 0.12))
    const label = typeof spec.label === 'string' ? spec.label : ''
    if (type.includes('focus') || type === 'f') {
      const m = h / f
      return [{ m, ys: h - m * span, ye: h, label }]
    }
    if (type.includes('centre') || type.includes('center') || type === 'c') {
      if (el.mirror) {
        const m = h / (2 * f)
        return [{ m, ys: h - m * span, ye: h, label }]
      }
      return [{ m: -h / span, ys: h, ye: 0, label }]
    }
    if (type.includes('pole') || type === 'p' || type.includes('optical')) {
      return [{ m: -h / span, ys: h, ye: 0, label }]
    }
    return [{ m: 0, ys: h, ye: h, label }]
  })
}

type Stage = {
  el: El
  /** The stage's object, in unfolded coordinates (light always travels +x). */
  ox: number
  oh: number
  img: Img | null
  /** Parallel rays from a distant object, at this slope. */
  par?: number
}

function stages(els: readonly El[], obj: Obj): Stage[] {
  const out: Stage[] = []
  let ox = obj.x
  let oh = obj.h
  let rest = els
  const [first] = els
  if (obj.slope !== undefined && first) {
    // Parallel rays meet in the focal plane, where the ray through the centre crosses it.
    const img: Img = {
      x: first.x + first.f,
      h: obj.slope * first.f,
      virtual: first.f < 0,
      far: false,
    }
    out.push({ el: first, ox: obj.x, oh: 0, img, par: obj.slope })
    ox = img.x
    oh = img.h
    rest = els.slice(1)
  }
  for (const el of rest) {
    const u = ox - el.x
    if (Math.abs(u) < 1e-9) break
    const inv = 1 / el.f + 1 / u
    let img: Img | null = null
    if (Math.abs(inv) > 1e-9) {
      const v = 1 / inv
      const far = Math.abs(v) > 6 * (Math.abs(u) + Math.abs(el.f))
      img = { x: el.x + v, h: (oh * v) / u, virtual: v < 0, far }
    }
    out.push({ el, ox, oh, img })
    if (!img || img.far) break
    ox = img.x
    oh = img.h
  }
  return out
}

/** Folds a point that is past a mirror back in front of it. */
const fold = (el: El, p: Pt): Pt => (el.mirror ? [2 * el.x - p[0], p[1]] : p)

type Ray = { m: number; ye: number; out: number }

function rays(s: Stage, count: number): Ray[] {
  const { el, ox, oh } = s
  if (s.par !== undefined) {
    const m = s.par
    const d = Math.max(Math.abs(m * el.f), Math.abs(el.f) * 0.2)
    return [0, d, -d].slice(0, Math.max(1, count)).map((ye) => ({ m, ye, out: m - ye / el.f }))
  }
  const span = el.x - ox
  const slopes = [0, -oh / span]
  const fx = el.x - el.f
  if (Math.abs(fx - ox) > 1e-6) slopes.push(-oh / (fx - ox))
  return slopes.slice(0, Math.max(1, count)).map((m) => {
    const ye = oh + m * span
    return { m, ye, out: m - ye / el.f }
  })
}

/** Where a stage's incoming ray starts: the object's tip, or far left for parallel rays. */
function rayStart(s: Stage, r: Ray): Pt {
  if (s.par === undefined) return [s.ox, s.oh]
  const L = s.el.x - s.ox
  return [s.ox, r.ye - r.m * L]
}

/** Half-height of an element: tall enough for every ray that meets it. */
function elementHalf(s: Stage, count: number): number {
  const hs = rays(s, count).map((r) => Math.abs(r.ye))
  return Math.max(Math.abs(s.oh) * 1.3, ...hs.map((h) => h * 1.15), Math.abs(s.el.f) * 0.15)
}

/** Where the outgoing rays of a stage end (unfolded x). */
function rayEnd(s: Stage, last: boolean): number {
  const { el, img } = s
  if (img && !img.virtual && !img.far) {
    const v = img.x - el.x
    return el.x + v * (last ? 1.3 : 1.12)
  }
  return el.x + Math.max(Math.abs(el.f) * 1.2, (el.x - s.ox) * 0.9)
}

const rayCount = (o: DiagramItem, n: number) => Math.round(num(o.rays, n > 1 ? 2 : 3))

export function opticsExtent(o: DiagramItem): Pt[] {
  switch (o.kind) {
    case 'prism': {
      const c = pt(o.at) ?? [0, 0]
      const r = num(o.side ?? o.size, 3)
      return [
        [c[0] - r * 1.25, c[1] - r * 0.25],
        [c[0] + r * 1.25, c[1] + r * 1.0],
      ]
    }
    case 'slab': {
      const c = pt(o.at) ?? [0, 0]
      const w = num(o.w ?? o.width, 4)
      const h = num(o.h ?? o.height ?? o.thickness, 1.5)
      return [
        [c[0] - w * 0.6, c[1] - h / 2 - w * 0.35],
        [c[0] + w * 0.6, c[1] + h / 2 + w * 0.35],
      ]
    }
    case 'refraction': {
      const c = pt(o.at) ?? [0, 0]
      const r = num(o.length ?? o.size, 2)
      return [
        [c[0] - r * 1.2, c[1] - r * 0.9],
        [c[0] + r * 1.2, c[1] + r * 0.9],
      ]
    }
  }
  const { els, obj } = setup(o)
  if (!els.length) return []
  const out: Pt[] = []
  for (const el of els) {
    const f = Math.abs(el.f)
    out.push([el.x - 2 * f, 0], [el.x + (el.mirror ? f * 0.3 : 2 * f), 0])
    if (el.mirror && el.f < 0) out.push([el.x + 2 * f, 0])
  }
  if (!obj) {
    for (const el of els) {
      const f = Math.abs(el.f)
      out.push([el.x, f * 0.5], [el.x, -f * 0.5], [el.x - 2.3 * f, 0])
      if (!el.mirror) out.push([el.x + 2.3 * f, 0])
      for (const r of rules(o, el)) {
        const end = el.x + 2.2 * f
        out.push([el.x - 2.2 * f, r.ys], fold(el, [end, r.ye + (r.m - r.ye / el.f) * (end - el.x)]))
        out.push([el.x, r.ye * 1.2])
      }
    }
    return out
  }
  if (obj.slope === undefined) out.push([obj.x, 0], [obj.x, obj.h])
  const st = stages(els, obj)
  const n = rayCount(o, st.length)
  st.forEach((s, i) => {
    const half = elementHalf(s, n)
    out.push([s.el.x, half], [s.el.x, -half])
    for (const r of rays(s, n)) out.push(rayStart(s, r))
    const end = rayEnd(s, i === st.length - 1)
    for (const r of rays(s, n)) out.push(fold(s.el, [end, r.ye + r.out * (end - s.el.x)]))
    if (s.img && !s.img.far) out.push(fold(s.el, [s.img.x, s.img.h]), fold(s.el, [s.img.x, 0]))
  })
  return out
}

export function drawOptics(o: DiagramItem, k: Sketch): void {
  if (o.kind === 'prism' || o.kind === 'slab') {
    drawBlock(o, k)
    return
  }
  if (o.kind === 'refraction') {
    drawSurface(o, k)
    return
  }
  const { els, obj } = setup(o)
  if (!els.length) return
  const pen = k.pen
  const z = k.size
  // The principal axis across the frame.
  pen.line(k.map([k.world.x[0], 0]), k.map([k.world.x[1], 0]))
  const st = obj ? stages(els, obj) : []
  const n = rayCount(o, st.length)
  const halves = new Map<El, number>()
  for (const s of st) halves.set(s.el, elementHalf(s, n))
  for (const el of els) {
    const ruled = obj ? [] : rules(o, el)
    const half = Math.max(Math.abs(el.f) * 0.5, ...ruled.map((r) => Math.abs(r.ye) * 1.25))
    drawElement(el, halves.get(el) ?? half, k)
    if (o.marks !== false) marks(el, k, els.length > 1)
    const f = Math.abs(el.f)
    for (const r of ruled) {
      const a = k.map([el.x - 2.2 * f, r.ys])
      const b = k.map([el.x, r.ye])
      pen.line(a, b)
      arrowOn(k, a, b, 0.55)
      const out = r.m - r.ye / el.f
      const end = el.x + 2.2 * f
      const c = k.map(fold(el, [end, r.ye + out * (end - el.x)]))
      pen.line(b, c)
      arrowOn(k, b, c, 0.5)
      // Diverging rays seem to come from F behind the element: show that dashed.
      const back = el.x - 1.3 * f
      if (el.f < 0 && Math.abs(out) > 1e-9) {
        pen.line(b, k.map(fold(el, [back, r.ye + out * (back - el.x)])), true)
      }
      if (r.label) k.label(r.label, a, [-1, 0], 3)
    }
  }
  if (!obj) return
  if (obj.slope === undefined) {
    arrowUp(k, [obj.x, 0], [obj.x, obj.h], false)
    if (obj.label) k.label(obj.label, k.map([obj.x, obj.h]), [0, obj.h >= 0 ? -1 : 1], 2)
  }
  st.forEach((s, i) => {
    const last = i === st.length - 1
    const { el } = s
    const end = rayEnd(s, last)
    for (const r of rays(s, n)) {
      const a = k.map(rayStart(s, r))
      const b = k.map([el.x, r.ye])
      pen.line(a, b)
      arrowOn(k, a, b, 0.55)
      const out = fold(el, [end, r.ye + r.out * (end - el.x)])
      const c = k.map(out)
      pen.line(b, c)
      arrowOn(k, b, c, 0.5)
      // Rays that spread out after the element seem to come from a virtual image behind it.
      if (s.img?.virtual && !s.img.far) {
        pen.line(b, k.map(fold(el, [s.img.x, s.img.h])), true)
      }
    }
    if (s.img && !s.img.far) {
      const foot = fold(el, [s.img.x, 0])
      const tip = fold(el, [s.img.x, s.img.h])
      arrowUp(k, foot, tip, s.img.virtual)
      const name =
        (last ? text(o, 'image') || text(o, 'image_label') : '') ||
        (Array.isArray(o.images) && typeof o.images[i] === 'string' ? (o.images[i] as string) : '')
      if (name) k.label(name, k.map(tip), [0, s.img.h >= 0 ? -1 : 1], 2)
    }
  })
  k.itemLabel(o, k.map([k.world.x[0], 0]), [1, -1], z * 0.3)
}

/** An upright arrow from foot to tip: objects and images. */
function arrowUp(k: Sketch, foot: Pt, tip: Pt, dashed: boolean): void {
  const a = k.map(foot)
  const b = k.map(tip)
  if (dist(a, b) < 1) return
  k.pen.line(a, b, dashed)
  k.pen.head(b, a, k.head * 0.9)
}

/** A small arrowhead partway along a ray, showing which way the light goes. */
function arrowOn(k: Sketch, a: Pt, b: Pt, t: number): void {
  if (dist(a, b) < k.size * 1.2) return
  const tip = lerp(a, b, t)
  const u = unit(a, b)
  k.pen.head(tip, [tip[0] - u[0], tip[1] - u[1]], k.head * 0.75)
}

function drawElement(el: El, half: number, k: Sketch): void {
  const pen = k.pen
  const z = k.size
  const [X, Y] = k.map([el.x, 0])
  const H = Math.max(z * 1.2, half * k.sy)
  const top: Pt = [X, Y - H]
  const bot: Pt = [X, Y + H]
  const w = Math.max(3, z * 0.28)
  if (!el.mirror) {
    if (el.f > 0) {
      pen.poly(quad(top, [X + 2 * w, Y], bot, 16))
      pen.poly(quad(top, [X - 2 * w, Y], bot, 16))
    } else {
      pen.poly([
        [X - w, Y - H],
        [X + w, Y - H],
        ...quad([X + w, Y - H], [X - w * 0.6, Y], [X + w, Y + H], 16).slice(1),
        [X - w, Y + H],
        ...quad([X - w, Y + H], [X + w * 0.6, Y], [X - w, Y - H], 16).slice(1),
      ])
    }
  } else {
    // Concave faces the light with its edges forward; convex bulges toward it.
    const sag = el.f > 0 ? -w * 1.2 : w * 1.2
    const curve = quad([X + sag, Y - H], [X - sag, Y], [X + sag, Y + H], 18)
    pen.poly(curve)
    // Silvering hatched on the back.
    for (let i = 1; i < curve.length - 1; i += 2) {
      const p = curve[i] as Pt
      pen.line([p[0] + 1, p[1]], [p[0] + z * 0.3, p[1] - z * 0.22])
    }
  }
  if (el.label) k.label(el.label, top, [0, -1], 3)
}

/** F and 2F (lenses), or P, F and C (mirrors), on the axis. */
function marks(el: El, k: Sketch, fociOnly: boolean): void {
  const z = k.size
  const tick = (x: number, name: string) => {
    if (x < k.world.x[0] || x > k.world.x[1]) return
    const [X, Y] = k.map([x, 0])
    k.pen.line([X, Y - z * 0.12], [X, Y + z * 0.12])
    k.label(name, [X, Y + z * 0.12], [0, 1], 2)
  }
  const f = el.f
  if (el.mirror) {
    tick(el.x - f, 'F')
    tick(el.x - 2 * f, 'C')
    const [X, Y] = k.map([el.x, 0])
    k.label('P', [X, Y], [1, 1], 3)
  } else {
    const a = Math.abs(f)
    tick(el.x - a, 'F')
    tick(el.x + a, "F'")
    if (fociOnly) return
    tick(el.x - 2 * a, '2F')
    tick(el.x + 2 * a, "2F'")
  }
}

// ---------------------------------------------------------------------------
// Snell's law: prisms, slabs and single surfaces
// ---------------------------------------------------------------------------

const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1]
const rot = (v: Pt, a: number): Pt => [
  v[0] * Math.cos(a) - v[1] * Math.sin(a),
  v[0] * Math.sin(a) + v[1] * Math.cos(a),
]

/** Bends direction d at a surface with normal `nrm` (any side), going from index n1 to n2. */
function bend(d: Pt, nrm: Pt, n1: number, n2: number): { d: Pt; tir: boolean } {
  const N: Pt = dot(nrm, d) > 0 ? [-nrm[0], -nrm[1]] : nrm
  const eta = n1 / n2
  const cosi = -dot(N, d)
  const k2 = 1 - eta * eta * (1 - cosi * cosi)
  if (k2 < 0) return { d: [d[0] + 2 * cosi * N[0], d[1] + 2 * cosi * N[1]], tir: true }
  const c = eta * cosi - Math.sqrt(k2)
  return { d: [eta * d[0] + c * N[0], eta * d[1] + c * N[1]], tir: false }
}

/** First hit of the ray p + t·d (t > ε) on the polygon's edges. */
function hit(poly: readonly Pt[], p: Pt, d: Pt): { at: Pt; normal: Pt } | null {
  let best: { t: number; at: Pt; normal: Pt } | null = null
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Pt
    const b = poly[(i + 1) % poly.length] as Pt
    const e: Pt = [b[0] - a[0], b[1] - a[1]]
    const den = d[0] * e[1] - d[1] * e[0]
    if (Math.abs(den) < 1e-12) continue
    const t = ((a[0] - p[0]) * e[1] - (a[1] - p[1]) * e[0]) / den
    const s = ((a[0] - p[0]) * d[1] - (a[1] - p[1]) * d[0]) / den
    if (t > 1e-6 && s >= 0 && s <= 1 && (!best || t < best.t)) {
      const len = Math.hypot(e[0], e[1])
      best = { t, at: [p[0] + d[0] * t, p[1] + d[1] * t], normal: [e[1] / len, -e[0] / len] }
    }
  }
  return best
}

function drawBlock(o: DiagramItem, k: Sketch): void {
  const c = pt(o.at) ?? [0, 0]
  const n = num(o.n ?? o.mu ?? o.index, 1.5)
  const i = deg(num(o.i ?? o.incidence ?? o.angle_of_incidence, 40))
  const pen = k.pen
  let poly: Pt[]
  let entry: Pt
  let inward: Pt
  if (o.kind === 'prism') {
    const side = num(o.side ?? o.size, 3)
    const A = deg(num(o.apex ?? o.angle ?? o.A, 60))
    const hb = side * Math.sin(A / 2)
    const h = side * Math.cos(A / 2)
    poly = [
      [c[0] - hb, c[1]],
      [c[0] + hb, c[1]],
      [c[0], c[1] + h],
    ]
    entry = lerp(poly[0] as Pt, poly[2] as Pt, 0.5)
    const e = unit(poly[0] as Pt, poly[2] as Pt)
    inward = [e[1], -e[0]]
    k.label(text(o, 'apex_label') || 'A', k.map(poly[2] as Pt), [0, -1], 3)
  } else {
    const w = num(o.w ?? o.width, 4)
    const h = num(o.h ?? o.height ?? o.thickness, 1.5)
    poly = [
      [c[0] - w / 2, c[1] - h / 2],
      [c[0] + w / 2, c[1] - h / 2],
      [c[0] + w / 2, c[1] + h / 2],
      [c[0] - w / 2, c[1] + h / 2],
    ]
    entry = [c[0] - w * 0.2, c[1] + h / 2]
    inward = [0, -1]
  }
  pen.poly(poly.map(k.map), true)
  // The incident ray comes in from the left, at angle i to the normal.
  const d0 = rot(inward, i)
  const L = num(
    o.ray ?? o.length,
    o.kind === 'prism' ? num(o.side ?? o.size, 3) * 0.7 : num(o.w ?? o.width, 4) * 0.4,
  )
  const start: Pt = [entry[0] - d0[0] * L, entry[1] - d0[1] * L]
  const path: Pt[] = [start, entry]
  const normals: { at: Pt; nrm: Pt }[] = [{ at: entry, nrm: inward }]
  let { d } = bend(d0, inward, 1, n)
  let p = entry
  let tirAt: Pt | null = null
  for (let bounce = 0; bounce < 4; bounce++) {
    const h = hit(poly, p, d)
    if (!h) break
    path.push(h.at)
    normals.push({ at: h.at, nrm: h.normal })
    const b = bend(d, h.normal, n, 1)
    p = h.at
    d = b.d
    if (!b.tir) break
    tirAt = tirAt ?? h.at
  }
  const end: Pt = [p[0] + d[0] * L, p[1] + d[1] * L]
  path.push(end)
  for (let s = 0; s + 1 < path.length; s++) {
    const a = k.map(path[s] as Pt)
    const b = k.map(path[s + 1] as Pt)
    pen.line(a, b)
    arrowOn(k, a, b, 0.55)
  }
  const nl = L * 0.45
  for (const { at, nrm } of normals) {
    pen.line(
      k.map([at[0] - nrm[0] * nl, at[1] - nrm[1] * nl]),
      k.map([at[0] + nrm[0] * nl, at[1] + nrm[1] * nl]),
      true,
    )
  }
  // Lateral shift: the incident ray carried on, dashed.
  if (o.kind === 'slab' && o.shift !== false) {
    pen.line(k.map(entry), k.map([entry[0] + d0[0] * L * 1.6, entry[1] + d0[1] * L * 1.6]), true)
  }
  // Deviation: the incident ray carried on through a prism, dashed.
  if (o.kind === 'prism' && o.deviation === true) {
    pen.line(k.map(entry), k.map([entry[0] + d0[0] * L * 1.8, entry[1] + d0[1] * L * 1.8]), true)
  }
  k.label('i', k.map(lerp(start, entry, 0.75)), o.kind === 'prism' ? [-0.3, -1] : [-1, 0.2], 3)
  if (path.length > 3) k.label('e', k.map(lerp(path.at(-2) as Pt, end, 0.25)), [0.3, -1], 3)
  if (tirAt) k.label('TIR', k.map(tirAt), [1, 0], 4)
  k.label(
    `$\\mu = ${n}$`,
    k.map(o.kind === 'prism' ? [c[0], c[1] + 0.25] : [c[0] + num(o.w ?? o.width, 4) * 0.32, c[1]]),
    [0, o.kind === 'prism' ? -1 : 0],
    2,
  )
  k.itemLabel(o, k.map(poly[0] as Pt), [-1, 1], 3)
}

/** One flat surface between two media: incident, refracted (or totally reflected) and normal. */
function drawSurface(o: DiagramItem, k: Sketch): void {
  const c = pt(o.at) ?? [0, 0]
  const n1 = num(o.n1, 1)
  const n2 = num(o.n2, 1.5)
  const i = deg(num(o.i ?? o.incidence ?? o.angle, 40))
  const L = num(o.length ?? o.size, 2)
  const tilt = deg(num(o.surface ?? o.tilt, 0))
  const w = (x: number, y: number): Pt => {
    const r = rot([x, y], tilt)
    return k.map([c[0] + r[0], c[1] + r[1]])
  }
  const pen = k.pen
  pen.line(w(-L * 1.2, 0), w(L * 1.2, 0))
  pen.line(w(0, -L * 0.9), w(0, L * 0.9), true)
  const d: Pt = [Math.sin(i), -Math.cos(i)]
  const src = w(-d[0] * L, -d[1] * L)
  const O = w(0, 0)
  pen.line(src, O)
  arrowOn(k, src, O, 0.55)
  const b = bend(d, [0, 1], n1, n2)
  const reflect = o.kind === 'reflection' || o.reflect === true || b.tir
  if (!b.tir) {
    const out = w(b.d[0] * L, b.d[1] * L)
    pen.line(O, out)
    arrowOn(k, O, out, 0.55)
    k.label('r', w(b.d[0] * L * 0.45, b.d[1] * L * 0.45 - L * 0.08), [1, 0.4], 3)
  }
  if (reflect) {
    const out = w(d[0] * L, -d[1] * L)
    pen.line(O, out)
    arrowOn(k, O, out, 0.55)
  }
  if (b.tir) k.label('TIR', w(-L * 0.6, -L * 0.4), [0, 0], 0)
  k.label('i', w(-d[0] * L * 0.45, -d[1] * L * 0.45 + L * 0.08), [-1, -0.4], 3)
  k.label(text(o, 'top') || `$n_1 = ${n1}$`, w(-L * 1.2, L * 0.1), [1, -1], 2)
  k.label(text(o, 'bottom') || `$n_2 = ${n2}$`, w(-L * 1.2, -L * 0.1), [1, 1], 2)
  k.itemLabel(o, w(L * 1.2, 0), [1, 0], 3)
}

/** The images a ray diagram forms, where they are drawn (mirror images folded back). */
export function opticsImages(o: DiagramItem): { x: number; h: number; virtual: boolean }[] {
  const { els, obj } = setup(o)
  if (!obj) return []
  return stages(els, obj).flatMap(({ el, img }) => {
    if (!img || img.far) return []
    const [x, h] = fold(el, [img.x, img.h])
    return [{ x, h, virtual: img.virtual }]
  })
}
