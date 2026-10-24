import { getStroke, type StrokeOptions } from 'perfect-freehand'
import type { Item, Stroke, TextItem } from './model'

export const TEXT_FONT = '"Segoe UI", system-ui, sans-serif'
export const TEXT_LINE_HEIGHT = 1.3
export const HIGHLIGHTER_ALPHA = 0.35

// Pressure is ignored in v1; simulated pressure (from speed) thins fast strokes slightly.
const PEN: StrokeOptions = {
  thinning: 0.35,
  smoothing: 0.5,
  streamline: 0.45,
  simulatePressure: true,
}
const HIGHLIGHTER: StrokeOptions = {
  thinning: 0,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: false,
}

/** Outline polygon for a stroke, as perfect-freehand produces it. */
export function strokeOutline(
  stroke: Pick<Stroke, 'tool' | 'width' | 'points'>,
  done = true,
): number[][] {
  const pts: number[][] = []
  for (let i = 0; i < stroke.points.length; i += 3) {
    pts.push([stroke.points[i] as number, stroke.points[i + 1] as number])
  }
  const base = stroke.tool === 'highlighter' ? HIGHLIGHTER : PEN
  return getStroke(pts, { ...base, size: stroke.width, last: done })
}

function outlinePath(outline: number[][]): Path2D {
  const path = new Path2D()
  const n = outline.length
  if (n < 2) return path
  // Quadratic curves through midpoints give a smooth closed outline.
  const first = outline[0] as number[]
  path.moveTo(first[0] as number, first[1] as number)
  for (let i = 0; i < n; i++) {
    const a = outline[i] as number[]
    const b = outline[(i + 1) % n] as number[]
    path.quadraticCurveTo(
      a[0] as number,
      a[1] as number,
      ((a[0] as number) + (b[0] as number)) / 2,
      ((a[1] as number) + (b[1] as number)) / 2,
    )
  }
  path.closePath()
  return path
}

const pathCache = new WeakMap<Stroke, Path2D>()

function strokePath(stroke: Stroke): Path2D {
  let path = pathCache.get(stroke)
  if (!path) {
    path = outlinePath(strokeOutline(stroke))
    pathCache.set(stroke, path)
  }
  return path
}

export function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Pick<Stroke, 'tool' | 'width' | 'points' | 'color'>,
  opts: { live?: boolean } = {},
): void {
  const path =
    !opts.live && 'id' in stroke
      ? strokePath(stroke as Stroke)
      : outlinePath(strokeOutline(stroke, !opts.live))
  ctx.save()
  if (stroke.tool === 'highlighter') {
    ctx.globalAlpha *= HIGHLIGHTER_ALPHA
    ctx.globalCompositeOperation = 'multiply'
  }
  ctx.fillStyle = stroke.color
  ctx.fill(path)
  ctx.restore()
}

/** Greedy word wrap. Explicit newlines always break. */
export function layoutText(
  ctx: CanvasRenderingContext2D,
  text: string,
  size: number,
  maxWidth: number,
): string[] {
  ctx.save()
  ctx.font = `${size}px ${TEXT_FONT}`
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/(\s+)/)) {
      const next = line + word
      if (line && ctx.measureText(next).width > maxWidth && word.trim()) {
        lines.push(line.trimEnd())
        line = word.trimStart()
      } else {
        line = next
      }
    }
    lines.push(line)
  }
  ctx.restore()
  return lines
}

export function drawText(ctx: CanvasRenderingContext2D, item: TextItem): void {
  const lines = layoutText(ctx, item.text, item.size, item.w)
  ctx.save()
  ctx.font = `${item.size}px ${TEXT_FONT}`
  ctx.fillStyle = item.color
  ctx.textBaseline = 'top'
  lines.forEach((line, i) => {
    ctx.fillText(line, item.x, item.y + i * item.size * TEXT_LINE_HEIGHT)
  })
  ctx.restore()
}

export type ImageSource = (assetId: string) => CanvasImageSource | null

export function drawItems(
  ctx: CanvasRenderingContext2D,
  items: readonly Item[],
  opts: { images: ImageSource; skip?: ReadonlySet<string> },
): void {
  for (const item of items) {
    if (opts.skip?.has(item.id)) continue
    if (item.kind === 'stroke') drawStroke(ctx, item)
    else if (item.kind === 'text') drawText(ctx, item)
    else {
      const img = opts.images(item.assetId)
      if (img) ctx.drawImage(img, item.x, item.y, item.w, item.h)
      else {
        ctx.save()
        ctx.fillStyle = '#f1f1f1'
        ctx.fillRect(item.x, item.y, item.w, item.h)
        ctx.restore()
      }
    }
  }
}
