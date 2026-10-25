// Focus region and line labels: what the AI sees (docs §5.1). Pure geometry over the
// page's items; the web app renders the result into images.

export type Rect = { x: number; y: number; w: number; h: number }

/** One thing on the page: a stroke, a typed text box, a line of PDF text or an image. */
export type Block = { id: string; rect: Rect; kind: 'ink' | 'text' | 'pdf' | 'image' }

export type Line = { rect: Rect; ids: string[]; labeled: boolean }

export type LabeledLine = { label: string; rect: Rect; ids: string[] }

export type Focus = { rect: Rect; lines: LabeledLine[] }

/** Vertical whitespace (pt) that separates one block of work from another. */
export const BLOCK_GAP = 34
/** At most this many lines are pulled in from the block above the work (the problem). */
const MAX_PROBLEM_LINES = 6
const PAD = { left: 30, right: 16, top: 12, bottom: 30 }
const MIN_WIDTH = 240

const bottom = (r: Rect) => r.y + r.h
const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(bottom(a), bottom(b)) - y }
}
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < bottom(b) && b.y < bottom(a)

/** Dots, accents and the like: attached to the nearest line instead of starting one. */
const isMark = (r: Rect) => r.w < 6 && r.h < 6
const MARK_REACH = 12

/**
 * Groups blocks into text lines, top to bottom. A block joins a line when its vertical
 * center falls inside the line (with a little slack for descenders). Small marks join
 * the nearest line. Images are never merged. Only lines with ink or typed text get labels.
 */
export function groupLines(blocks: readonly Block[]): Line[] {
  const lines: (Line & { image: boolean })[] = []
  const add = (b: Block, line: (typeof lines)[number] | undefined) => {
    const labeled = b.kind === 'ink' || b.kind === 'text'
    if (line) {
      line.rect = union(line.rect, b.rect)
      line.ids.push(b.id)
      line.labeled ||= labeled
    } else {
      lines.push({ rect: { ...b.rect }, ids: [b.id], labeled, image: b.kind === 'image' })
    }
  }
  const sorted = [...blocks].sort((a, b) => a.rect.y - b.rect.y)
  for (const b of sorted) {
    if (isMark(b.rect) && b.kind !== 'image') continue
    const cy = b.rect.y + b.rect.h / 2
    add(
      b,
      b.kind === 'image'
        ? undefined
        : lines.find((l) => {
            if (l.image) return false
            const slack = Math.min(l.rect.h, 30) * 0.25
            return cy >= l.rect.y - slack && cy <= bottom(l.rect) + slack
          }),
    )
  }
  for (const b of sorted) {
    if (!isMark(b.rect) || b.kind === 'image') continue
    const cy = b.rect.y + b.rect.h / 2
    let best: (typeof lines)[number] | undefined
    let bestDist = MARK_REACH
    for (const l of lines) {
      if (l.image) continue
      const d = cy < l.rect.y ? l.rect.y - cy : cy > bottom(l.rect) ? cy - bottom(l.rect) : 0
      if (d <= bestDist) {
        best = l
        bestDist = d
      }
    }
    add(b, best)
  }
  return lines
    .sort((a, b) => a.rect.y - b.rect.y)
    .map(({ rect, ids, labeled }) => ({ rect, ids, labeled }))
}

/** Indices of the contiguous block (no gap > BLOCK_GAP) that ends at line `end`. */
function blockAbove(lines: readonly Line[], end: number, limit = Number.POSITIVE_INFINITY) {
  let start = end
  while (start > 0 && end - start + 1 < limit) {
    const prev = lines[start - 1] as Line
    const top = (lines[start] as Line).rect.y
    if (top - bottom(prev.rect) > BLOCK_GAP) break
    start--
  }
  return start
}

/**
 * Picks the part of the page a request is about. A lasso selection wins. Otherwise the
 * lines holding recently written items (or the last block of work on the page), extended
 * up to the problem statement: everything contiguous above, plus the first block above
 * a whitespace gap.
 */
export function focusRegion(
  blocks: readonly Block[],
  opts: {
    page: { width: number; height: number }
    recent: ReadonlySet<string>
    selection?: Rect | null
  },
): Focus {
  const { page } = opts
  const lines = groupLines(blocks)
  const whole = { x: 0, y: 0, w: page.width, h: page.height }
  if (!lines.some((l) => l.labeled) && !opts.selection) return { rect: whole, lines: label(lines) }

  let picked: Line[]
  let rect: Rect
  if (opts.selection) {
    picked = lines.filter((l) => overlaps(l.rect, opts.selection as Rect))
    rect = picked.reduce((r, l) => union(r, l.rect), opts.selection)
  } else {
    const anchors = lines.flatMap((l, i) =>
      l.labeled && l.ids.some((id) => opts.recent.has(id)) ? [i] : [],
    )
    let lo: number
    let hi: number
    if (anchors.length) {
      lo = anchors[0] as number
      hi = anchors[anchors.length - 1] as number
    } else {
      hi = lines.findLastIndex((l) => l.labeled)
      lo = hi
    }
    lo = blockAbove(lines, lo)
    if (lo > 0) lo = blockAbove(lines, lo - 1, MAX_PROBLEM_LINES)
    picked = lines.slice(lo, hi + 1)
    rect = picked.reduce((r, l) => union(r, l.rect), (picked[0] as Line).rect)
  }

  rect = pad(rect, page)
  return { rect, lines: label(picked) }
}

function pad(r: Rect, page: { width: number; height: number }): Rect {
  let x = r.x - PAD.left
  let w = r.w + PAD.left + PAD.right
  if (w < MIN_WIDTH) {
    x -= (MIN_WIDTH - w) / 2
    w = MIN_WIDTH
  }
  // Near an edge, slide the box back onto the page rather than cutting it.
  w = Math.min(w, page.width)
  x = Math.min(Math.max(0, x), page.width - w)
  const y = Math.max(0, r.y - PAD.top)
  return { x, y, w, h: Math.min(page.height, r.y + r.h + PAD.bottom) - y }
}

function label(lines: readonly Line[]): LabeledLine[] {
  let n = 0
  return lines.flatMap((l) => (l.labeled ? [{ label: `L${++n}`, rect: l.rect, ids: l.ids }] : []))
}
