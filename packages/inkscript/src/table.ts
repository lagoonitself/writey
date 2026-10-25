import { handLine, type Path, type Rng, shiftPaths } from './layout'
import { layoutParagraph, stackLines } from './text'

// A hand-drawn table (truth tables, observation tables, comparisons): cells are written
// like any other line (words with inline $math$), centred in a ruled grid. Units are em.

export type TableSpec = {
  header?: string[]
  rows: string[][]
  /** Per column: 'l', 'c' (default) or 'r'. */
  align?: string[]
}

const PAD_X = 0.5
const PAD_Y = 0.32
/** Longest a cell line runs before it wraps, em. */
const CELL_MAX = 12

export function drawTable(spec: TableSpec, rng: Rng): { w: number; h: number; paths: Path[] } {
  const rows = spec.header?.length ? [spec.header, ...spec.rows] : spec.rows
  const cols = Math.max(0, ...rows.map((r) => r.length))
  if (!cols) return { w: 0, h: 0, paths: [] }
  const boxes = rows.map((r) =>
    Array.from({ length: cols }, (_, j) => {
      const s = (r[j] ?? '').trim()
      return s ? stackLines(layoutParagraph(s, CELL_MAX, rng), 1.25) : null
    }),
  )
  const colW = Array.from({ length: cols }, (_, j) =>
    Math.max(1.1, ...boxes.map((r) => r[j]?.w ?? 0)),
  )
  const rowH = boxes.map((r) => Math.max(0.75, ...r.map((b) => (b ? b.h + b.d : 0))))
  const xs = [0]
  for (const w of colW) xs.push((xs.at(-1) as number) + w + 2 * PAD_X)
  const ys = [0]
  for (const h of rowH) ys.push((ys.at(-1) as number) + h + 2 * PAD_Y)
  const W = xs.at(-1) as number
  const H = ys.at(-1) as number

  // The grid first, as a person rules it: the frame, then rows, then columns.
  const paths: Path[] = [
    handLine(0, 0, W, 0, rng),
    handLine(W, 0, W, H, rng),
    handLine(W, H, 0, H, rng),
    handLine(0, H, 0, 0, rng),
  ]
  ys.slice(1, -1).forEach((y, i) => {
    paths.push(handLine(-0.05, y, W + 0.05, y, rng))
    // A double rule under the header.
    if (i === 0 && spec.header?.length) paths.push(handLine(0, y + 0.1, W, y + 0.1, rng))
  })
  for (const x of xs.slice(1, -1)) paths.push(handLine(x, -0.05, x, H + 0.05, rng))

  boxes.forEach((r, i) => {
    const top = (ys[i] as number) + PAD_Y + (i === 1 && spec.header?.length ? 0.06 : 0)
    r.forEach((b, j) => {
      if (!b) return
      const a = spec.align?.[j] ?? 'c'
      const free = (colW[j] as number) - b.w
      const x = (xs[j] as number) + PAD_X + (a === 'l' ? 0 : a === 'r' ? free : free / 2)
      // Single lines sit on a common baseline in the row's middle.
      const y = top + ((rowH[i] as number) - (b.h + b.d)) / 2 + b.h
      paths.push(...shiftPaths(b.paths, x, y))
    })
  })
  return { w: W, h: H, paths }
}
