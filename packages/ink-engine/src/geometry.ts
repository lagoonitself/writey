import type { Item, Rect, Stroke } from './model'

export function itemBounds(item: Item): Rect {
  if (item.kind !== 'stroke') return { x: item.x, y: item.y, w: item.w, h: item.h }
  const p = item.points
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] as number
    const y = p[i + 1] as number
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const r = item.width / 2
  return { x: minX - r, y: minY - r, w: maxX - minX + 2 * r, h: maxY - minY + 2 * r }
}

export function unionBounds(items: readonly Item[]): Rect | null {
  if (items.length === 0) return null
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const item of items) {
    const b = itemBounds(item)
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function rectContains(r: Rect, x: number, y: number, pad = 0): boolean {
  return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad
}

function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  let t = len === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx - px
  const cy = ay + t * dy - py
  return cx * cx + cy * cy
}

/** True if (x, y) touches the item, with `radius` of slack (eraser size). */
export function hitItem(item: Item, x: number, y: number, radius: number): boolean {
  if (item.kind !== 'stroke') return rectContains(item, x, y, radius)
  const p = item.points
  const reach = radius + item.width / 2
  const reachSq = reach * reach
  if (p.length === 3) {
    const dx = (p[0] as number) - x
    const dy = (p[1] as number) - y
    return dx * dx + dy * dy <= reachSq
  }
  for (let i = 3; i < p.length; i += 3) {
    const d = distToSegmentSq(
      x,
      y,
      p[i - 3] as number,
      p[i - 2] as number,
      p[i] as number,
      p[i + 1] as number,
    )
    if (d <= reachSq) return true
  }
  return false
}

/** Even-odd point-in-polygon test. `poly` is flat [x, y, x, y, …]. */
export function pointInPolygon(poly: readonly number[], x: number, y: number): boolean {
  let inside = false
  const n = poly.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i] as number
    const yi = poly[2 * i + 1] as number
    const xj = poly[2 * j] as number
    const yj = poly[2 * j + 1] as number
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** A stroke is lassoed when most of its points are inside; boxes when their center is. */
export function itemInLasso(item: Item, poly: readonly number[]): boolean {
  if (poly.length < 6) return false
  if (item.kind !== 'stroke') return pointInPolygon(poly, item.x + item.w / 2, item.y + item.h / 2)
  const p = item.points
  let inside = 0
  const total = p.length / 3
  for (let i = 0; i < p.length; i += 3) {
    if (pointInPolygon(poly, p[i] as number, p[i + 1] as number)) inside++
  }
  return inside / total >= 0.6
}

export function translateItem<T extends Item>(item: T, dx: number, dy: number): T {
  if (item.kind !== 'stroke') return { ...item, x: item.x + dx, y: item.y + dy }
  const points = item.points.slice()
  for (let i = 0; i < points.length; i += 3) {
    points[i] = (points[i] as number) + dx
    points[i + 1] = (points[i + 1] as number) + dy
  }
  return { ...item, points }
}

/** Scales an item around (ox, oy). Stroke widths and text sizes scale with the average factor. */
export function scaleItem<T extends Item>(item: T, ox: number, oy: number, s: number): T {
  if (item.kind === 'stroke') {
    const points = item.points.slice()
    for (let i = 0; i < points.length; i += 3) {
      points[i] = ox + ((points[i] as number) - ox) * s
      points[i + 1] = oy + ((points[i + 1] as number) - oy) * s
    }
    return { ...item, points, width: item.width * s }
  }
  const moved = {
    ...item,
    x: ox + (item.x - ox) * s,
    y: oy + (item.y - oy) * s,
    w: item.w * s,
    h: item.h * s,
  }
  return item.kind === 'text' ? { ...moved, size: (item as { size: number }).size * s } : moved
}

/**
 * Erases the part of a stroke within `radius` of (x, y), like rubbing out pencil.
 * Returns null when nothing was touched, otherwise the surviving pieces (possibly none).
 * Long segments are subdivided first so the cut lands where the eraser is.
 */
export function eraseStroke(
  stroke: Stroke,
  x: number,
  y: number,
  radius: number,
  makeId: () => string,
): Stroke[] | null {
  if (!hitItem(stroke, x, y, radius)) return null
  const reach = radius + stroke.width / 2
  const reachSq = reach * reach
  const step = Math.max(0.5, radius / 2)
  const p = stroke.points
  const pieces: number[][] = []
  let run: number[] = []
  const visit = (px: number, py: number, t: number) => {
    const dx = px - x
    const dy = py - y
    if (dx * dx + dy * dy <= reachSq) {
      if (run.length) pieces.push(run)
      run = []
    } else run.push(px, py, t)
  }
  visit(p[0] as number, p[1] as number, p[2] as number)
  for (let i = 3; i < p.length; i += 3) {
    const ax = p[i - 3] as number
    const ay = p[i - 2] as number
    const at = p[i - 1] as number
    const bx = p[i] as number
    const by = p[i + 1] as number
    const bt = p[i + 2] as number
    // Only densify segments that pass near the eraser; the rest keep their points.
    const near = distToSegmentSq(x, y, ax, ay, bx, by) <= reachSq
    const n = near ? Math.ceil(Math.hypot(bx - ax, by - ay) / step) : 1
    for (let k = 1; k <= n; k++) {
      const f = k / n
      visit(ax + (bx - ax) * f, ay + (by - ay) * f, at + (bt - at) * f)
    }
  }
  if (run.length) pieces.push(run)
  // A lone point would render as a stray dot; drop it.
  return pieces
    .filter((pts) => pts.length >= 6)
    .map((points) => ({ ...stroke, id: makeId(), points }))
}
