import { drawCircuit, inputOffsets, junctionDots } from './circuit'
import type { DiagramItem, Pt, Sketch } from './sketch'

// Logic circuits laid out by Writey. The model gives a netlist (inputs, gates and what feeds
// each gate, outputs) and never places anything: gates go in columns by depth, inputs come
// down rails on the left, and wires run only across or up and down, with a channel per net
// between columns, so nothing crosses a gate and every branch gets its junction dot.

export const LOGIC_KINDS: Record<string, string> = {
  logic: 'logic',
  logic_circuit: 'logic',
  netlist: 'logic',
  gates: 'logic',
}

const RAIL = 0.9
const COL = 4.4
const ROW = 2.4
const CLEAR = 0.2

type Gate = {
  id: string
  type: string
  ins: string[]
  label: string
  level: number
  x: number
  y: number
  /** Half-height of the body. */
  hh: number
}

type Seg = [Pt, Pt]

export type LogicLayout = {
  gates: DiagramItem[]
  segs: Seg[]
  labels: { text: string; at: Pt; dir: Pt }[]
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

function parse(o: DiagramItem): { inputs: string[]; gates: Gate[]; outputs: [string, string][] } {
  const gates: Gate[] = []
  for (const g of Array.isArray(o.gates) ? o.gates : []) {
    if (!g || typeof g !== 'object') continue
    const r = g as Record<string, unknown>
    const id = str(r.id) || str(r.name) || str(r.out) || `g${gates.length + 1}`
    const type = (str(r.type) || str(r.kind) || 'and').toLowerCase()
    const raw = r.in ?? r.inputs ?? r.from
    const ins = (Array.isArray(raw) ? raw : [raw]).map(str).filter(Boolean)
    if (!ins.length) continue
    gates.push({
      id,
      type,
      ins: type === 'not' ? ins.slice(0, 1) : ins.slice(0, 4),
      label: str(r.label),
      level: 1,
      x: 0,
      y: 0,
      hh: 0.4,
    })
  }
  const ids = new Set(gates.map((g) => g.id))
  const inputs = (Array.isArray(o.inputs) ? o.inputs : []).map(str).filter(Boolean)
  for (const g of gates)
    for (const s of g.ins) if (!ids.has(s) && !inputs.includes(s)) inputs.push(s)
  let outputs: [string, string][] = []
  if (Array.isArray(o.outputs)) {
    outputs = o.outputs.flatMap((v): [string, string][] => {
      if (typeof v === 'string') return [[v, v]]
      const r = (v ?? {}) as Record<string, unknown>
      const name = str(r.name) || str(r.label)
      const from = str(r.from) || str(r.id) || name
      return from ? [[name || from, from]] : []
    })
  } else if (o.outputs && typeof o.outputs === 'object') {
    outputs = Object.entries(o.outputs as Record<string, unknown>).map(([name, from]) => [
      name,
      str(from),
    ])
  }
  return { inputs, gates, outputs: outputs.filter(([, from]) => ids.has(from)) }
}

export function layoutLogic(o: DiagramItem): LogicLayout | null {
  const { inputs, gates, outputs } = parse(o)
  if (!gates.length) return null
  const byId = new Map(gates.map((g) => [g.id, g]))
  // Depth: one more than the deepest source. A loop (a latch) stops growing at the gate count.
  for (let pass = 0; pass < gates.length; pass++) {
    let changed = false
    for (const g of gates) {
      const level = 1 + Math.max(0, ...g.ins.map((s) => byId.get(s)?.level ?? 0))
      const capped = Math.min(level, gates.length)
      if (capped !== g.level) {
        g.level = capped
        changed = true
      }
    }
    if (!changed) break
  }
  const levels = Math.max(...gates.map((g) => g.level))
  const x1 = Math.max(0, inputs.length - 1) * RAIL + 2.6
  const colX = (level: number) => x1 + (level - 1) * COL
  const railX = (name: string) => inputs.indexOf(name) * RAIL
  const srcLevel = (s: string) => byId.get(s)?.level ?? 0

  /** Pins whose wire runs across earlier columns must stay clear of the gates there. */
  const blocked = (g: Gate, y: number): boolean =>
    g.ins.some((s, i) => {
      const from = srcLevel(s)
      if (from >= g.level - 1 && from > 0) return false
      const off = inputOffsets(g.type, g.ins.length)[i] ?? 0
      const py = y + off
      return gates.some(
        (h) => h.level > from && h.level < g.level && Math.abs(py - h.y) < h.hh + CLEAR,
      )
    })

  for (let level = 1; level <= levels; level++) {
    const col = gates.filter((g) => g.level === level)
    for (const g of col) {
      const ys = g.ins.map((s) => byId.get(s)?.y).filter((y): y is number => y !== undefined)
      g.y = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : -col.indexOf(g) * ROW
      // Sources higher on the page feed the higher pins.
      if (g.ins.every((s) => byId.has(s))) {
        g.ins.sort((a, b) => (byId.get(b)?.y ?? 0) - (byId.get(a)?.y ?? 0))
      }
      const offs = inputOffsets(g.type, g.ins.length)
      g.hh = Math.max(0.4, Math.abs(offs[0] ?? 0) + 0.12)
      g.x = colX(level)
    }
    col.sort((a, b) => b.y - a.y)
    let prev = Number.POSITIVE_INFINITY
    for (const g of col) {
      g.y = Math.min(g.y, prev - ROW)
      for (let k = 0; k < 40 && blocked(g, g.y); k++) g.y -= 0.2
      prev = g.y
    }
  }

  const segs: Seg[] = []
  const labels: LogicLayout['labels'] = []
  const pin = (g: Gate, i: number): Pt => [
    g.x - 1,
    g.y + (inputOffsets(g.type, g.ins.length)[i] ?? 0),
  ]
  const sinks = (s: string) =>
    gates.flatMap((g) => g.ins.flatMap((src, i) => (src === s ? [{ g, p: pin(g, i) }] : [])))

  // Inputs: a rail down from the label, a tap across to each pin it feeds.
  const top = Math.max(...gates.map((g) => g.y + g.hh)) + 0.9
  for (const name of inputs) {
    const taps = sinks(name)
    if (!taps.length) continue
    const x = railX(name)
    const bottom = Math.min(...taps.map((t) => t.p[1]))
    segs.push([
      [x, top],
      [x, bottom],
    ])
    for (const t of taps) segs.push([[x, t.p[1]], t.p])
    labels.push({ text: name, at: [x, top], dir: [0, -1] })
  }

  // Gate outputs: across to a channel just right of the column, down or up, across to the pins.
  const xEnd = colX(levels) + 2.4
  for (let level = 1; level <= levels; level++) {
    const col = gates.filter((g) => g.level === level).sort((a, b) => b.y - a.y)
    const gap0 = colX(level) + 1
    const gapW = COL - 2
    col.forEach((g, k) => {
      const out: Pt = [g.x + 1, g.y]
      const taps = sinks(g.id)
      const named = outputs.filter(([, from]) => from === g.id)
      if (taps.length) {
        const ch = gap0 + ((k + 1) * gapW) / (col.length + 1)
        const ys = [g.y, ...taps.map((t) => t.p[1])]
        segs.push([out, [ch, g.y]])
        if (Math.max(...ys) - Math.min(...ys) > 1e-6) {
          segs.push([
            [ch, Math.max(...ys)],
            [ch, Math.min(...ys)],
          ])
        }
        for (const t of taps) segs.push([[ch, t.p[1]], t.p])
        if (named.length)
          segs.push([
            [ch, g.y],
            [xEnd, g.y],
          ])
      } else if (named.length) segs.push([out, [xEnd, g.y]])
      named.forEach(([name], i) => {
        labels.push({ text: name, at: [xEnd, g.y - i * 0.6], dir: [1, 0] })
      })
    })
  }

  return {
    gates: gates.map((g) => ({
      kind: 'gate',
      type: g.type,
      at: [g.x, g.y],
      size: 1,
      inputs: g.ins.length,
      ...(g.label ? { label: g.label } : o.names === true ? { name: true } : {}),
    })),
    segs: segs.filter(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6),
    labels,
  }
}

export function logicExtent(o: DiagramItem): Pt[] {
  const l = layoutLogic(o)
  if (!l) return []
  const out: Pt[] = l.segs.flat()
  for (const g of l.gates) {
    const c = g.at as Pt
    out.push([c[0] - 1, c[1] - 0.7], [c[0] + 1, c[1] + 0.7])
  }
  for (const t of l.labels)
    out.push([t.at[0] + t.dir[0] * 1.6, t.at[1] + t.dir[1] * 0.2 + (t.dir[1] < 0 ? 0.8 : 0)])
  return out
}

export function drawLogic(o: DiagramItem, k: Sketch): void {
  const l = layoutLogic(o)
  if (!l) return
  for (const g of l.gates) drawCircuit(g as DiagramItem, k)
  for (const [a, b] of l.segs) k.pen.line(k.map(a), k.map(b), false, true)
  for (const p of junctionDots(l.segs)) k.pen.dot(k.map(p), Math.max(1.4, k.size * 0.09))
  for (const t of l.labels) k.label(t.text, k.map(t.at), t.dir, 3)
  k.itemLabel(o, k.map([0, Math.min(...l.gates.map((g) => (g.at as Pt)[1])) - 1]), [1, 1], 3)
}
