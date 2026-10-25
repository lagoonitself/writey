import {
  type Block,
  focusRegion,
  type LabeledLine,
  type PageContext,
  type Rect,
} from '@writey/ai-core'
import { drawItems, type Item, itemBounds } from '@writey/ink-engine'
import type { PageRow } from '@writey/shared'
import { loadImage } from '../lib/assets'
import { drawPdfRegion, type PdfTextLine, pdfTextLines } from '../lib/pdf'
import type { PageSnapshot } from '../notebook/tools'

// Context capture (docs §5.1): render the focus region with line tags, plus a small
// whole-page thumbnail, from our own canvas model. No screen capture.

const FOCUS_MAX_PX = 1344
const FOCUS_MAX_SCALE = 4
const THUMB_MAX_PX = 512
const TAG_COLOR = '#d4148c'

export type Capture = {
  ctx: PageContext
  focusRect: Rect
  /** The tagged lines, in page points, for placing AI ink (docs §5.4). */
  lines: LabeledLine[]
  /** Everything AI ink must not overlap: items and printed PDF text. */
  obstacles: Rect[]
}

export async function capturePage(page: PageRow, snap: PageSnapshot): Promise<Capture> {
  const bg = page.background
  const pdfLines =
    bg.kind === 'pdf' ? await pdfTextLines(bg.assetId, bg.pdfPage).catch(() => []) : []
  const blocks: Block[] = [
    ...snap.items.map(
      (item): Block => ({
        id: item.id,
        rect: itemBounds(item),
        kind: item.kind === 'stroke' ? 'ink' : item.kind,
      }),
    ),
    ...pdfLines.map((l, i): Block => ({ id: `pdf:${i}`, rect: l, kind: 'pdf' })),
  ]
  const size = { width: page.width, height: page.height }
  const focus = focusRegion(blocks, { page: size, recent: snap.recent, selection: snap.selection })
  const r = focus.rect

  const images = await loadImages(snap.items)
  const scale = Math.min(FOCUS_MAX_SCALE, FOCUS_MAX_PX / Math.max(r.w, r.h))
  const focusCanvas = await renderRegion(page, snap.items, images, r, scale)
  drawTags(focusCanvas, focus.lines, r, scale)

  const thumbScale = THUMB_MAX_PX / Math.max(page.width, page.height)
  const whole = { x: 0, y: 0, w: page.width, h: page.height }
  const thumb = await renderRegion(page, snap.items, images, whole, thumbScale)
  const tctx = thumb.getContext('2d') as CanvasRenderingContext2D
  tctx.strokeStyle = TAG_COLOR
  tctx.lineWidth = 2
  tctx.strokeRect(r.x * thumbScale, r.y * thumbScale, r.w * thumbScale, r.h * thumbScale)

  // Ink on white compresses best as PNG; photos and PDFs as JPEG.
  const encode = (c: HTMLCanvasElement) =>
    bg.kind === 'blank' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85)

  const inFocus = new Set(focus.lines.flatMap((l) => l.ids))
  const aiGroups = new Set(
    snap.items.flatMap((i) =>
      i.kind === 'stroke' && i.groupId && inFocus.has(i.id) ? [i.groupId] : [],
    ),
  )
  return {
    focusRect: r,
    lines: focus.lines,
    obstacles: [...snap.items.map(itemBounds), ...pdfLines],
    ctx: {
      focusImage: encode(focusCanvas),
      pageImage: encode(thumb),
      labels: focus.lines.map((l) => l.label),
      typedText: snap.items.flatMap((i) =>
        i.kind === 'text' && inFocus.has(i.id) ? [i.text] : [],
      ),
      pdfText: pdfLines
        .filter((l) => intersects(l, r))
        .map((l: PdfTextLine) => l.text)
        .join('\n'),
      selection: Boolean(snap.selection),
      aiInk: [...aiGroups].flatMap((g) => {
        const src = snap.aiSource(g)?.source
        return src ? [src] : []
      }),
      transcript: snap.transcript,
    },
  }
}

const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

async function loadImages(items: readonly Item[]): Promise<Map<string, HTMLImageElement>> {
  const ids = [...new Set(items.flatMap((i) => (i.kind === 'image' ? [i.assetId] : [])))]
  const loaded = await Promise.all(ids.map((id) => loadImage(id).catch(() => null)))
  const map = new Map<string, HTMLImageElement>()
  ids.forEach((id, i) => {
    const img = loaded[i]
    if (img) map.set(id, img)
  })
  return map
}

async function renderRegion(
  page: PageRow,
  items: readonly Item[],
  images: Map<string, HTMLImageElement>,
  r: Rect,
  scale: number,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(r.w * scale))
  canvas.height = Math.max(1, Math.round(r.h * scale))
  const bg = page.background
  if (bg.kind === 'pdf') {
    await drawPdfRegion(canvas, bg.assetId, bg.pdfPage, scale, r.x, r.y).catch(console.error)
  }
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  ctx.save()
  ctx.globalCompositeOperation = 'destination-over'
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.restore()
  ctx.setTransform(scale, 0, 0, scale, -r.x * scale, -r.y * scale)
  if (bg.kind === 'image') {
    const img = await loadImage(bg.assetId).catch(() => null)
    if (img) ctx.drawImage(img, 0, 0, page.width, page.height)
  }
  drawItems(ctx, items, { images: (id) => images.get(id) ?? null })
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  return canvas
}

/** Magenta L1, L2… tags left of each line, in image pixels so they stay readable. */
function drawTags(
  canvas: HTMLCanvasElement,
  lines: { label: string; rect: Rect }[],
  r: Rect,
  scale: number,
) {
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  ctx.textBaseline = 'middle'
  for (const line of lines) {
    // About half the line's height, so tags read clearly next to big or small writing.
    const size = Math.round(Math.max(13, Math.min(26, line.rect.h * scale * 0.45)))
    ctx.font = `bold ${size}px system-ui, sans-serif`
    const pad = size * 0.3
    const w = ctx.measureText(line.label).width + pad * 2
    const h = size * 1.3
    const cy = (line.rect.y + line.rect.h / 2 - r.y) * scale
    const x = Math.max(0, (line.rect.x - r.x) * scale - w - pad)
    ctx.fillStyle = TAG_COLOR
    ctx.beginPath()
    ctx.roundRect(x, cy - h / 2, w, h, size * 0.3)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.fillText(line.label, x + pad, cy + 0.5)
  }
}
