import { callForBytes } from '../lib/native'

// Real diagrams from the web (HANDOFF D49): Writey searches Wikimedia Commons, whose
// pictures are all free to reuse with credit, shows the model a numbered contact sheet,
// and pastes the one it picks onto the page. Line drawings (SVG) come first: they read like
// textbook figures and print cleanly.

const API = 'https://commons.wikimedia.org/w/api.php'
/** Width Commons renders pictures at for us; SVGs come back as PNG. */
const THUMB_PX = 960
const MAX_HITS = 6
const MIN_PX = 240
const MIMES = new Set(['image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export type PictureHit = {
  title: string
  /** The picture at THUMB_PX wide (or smaller originals as they are). */
  url: string
  width: number
  height: number
  /** A line drawing (SVG) rather than a photo or scan. */
  drawing: boolean
  license: string
  artist: string
  /** Its page on Commons, for the credit. */
  page: string
  description: string
}

type ApiPage = {
  title: string
  index?: number
  imageinfo?: {
    url: string
    thumburl?: string
    thumbwidth?: number
    thumbheight?: number
    width: number
    height: number
    mime: string
    descriptionurl: string
    extmetadata?: Record<string, { value?: string }>
  }[]
}

/** Plain text from the HTML Commons keeps in its metadata. */
export function plain(html: string | undefined, max = 140): string {
  const s = (html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** "File:Diagram of the human heart (cropped).svg" → "Diagram of the human heart (cropped)". */
export const shortTitle = (t: string) => t.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '')

async function search(query: string, filetype: string, signal: AbortSignal): Promise<PictureHit[]> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    origin: '*',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: `${query} filetype:${filetype}`,
    gsrlimit: '12',
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiextmetadatafilter: 'LicenseShortName|Artist|ImageDescription',
    iiurlwidth: String(THUMB_PX),
  })
  const res = await fetch(`${API}?${params}`, { signal })
  if (!res.ok) throw new Error(`Wikimedia Commons answered ${res.status}`)
  const data = (await res.json()) as { query?: { pages?: ApiPage[] } }
  const pages = [...(data.query?.pages ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  return pages.flatMap((p): PictureHit[] => {
    const i = p.imageinfo?.[0]
    if (!i || !MIMES.has(i.mime) || Math.max(i.width, i.height) < MIN_PX) return []
    const meta = i.extmetadata ?? {}
    return [
      {
        title: shortTitle(p.title),
        url: i.thumburl ?? i.url,
        width: i.thumbwidth ?? i.width,
        height: i.thumbheight ?? i.height,
        drawing: i.mime === 'image/svg+xml',
        license: plain(meta.LicenseShortName?.value, 40) || 'see Commons',
        artist: plain(meta.Artist?.value, 60) || 'unknown author',
        page: i.descriptionurl,
        description: plain(meta.ImageDescription?.value),
      },
    ]
  })
}

/** Up to six free pictures for the query: drawings first, then photos and scans. */
export async function searchPictures(query: string, signal: AbortSignal): Promise<PictureHit[]> {
  const drawings = await search(query, 'drawing', signal)
  const hits = drawings.slice(0, MAX_HITS)
  if (hits.length < MAX_HITS) {
    const more = await search(query, 'bitmap', signal).catch(() => [])
    hits.push(...more.slice(0, MAX_HITS - hits.length))
  }
  return hits
}

/** The picture's bytes: straight from Commons, or fetched by the app if that fails. */
export async function pictureBlob(url: string, signal: AbortSignal): Promise<Blob> {
  try {
    const res = await fetch(url, { signal, mode: 'cors' })
    if (res.ok) return await res.blob()
  } catch (e) {
    if (signal.aborted) throw e
  }
  const bytes = await callForBytes('picture_fetch', { url }).catch(() => {
    throw new Error("couldn't download the picture")
  })
  return new Blob([bytes as BlobPart], { type: sniffImage(bytes) })
}

/** An image's type from its first bytes (PNG, JPEG, GIF, WebP), or '' if unknown. */
export function sniffImage(b: Uint8Array): string {
  const at = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0))
  if (b[0] === 0x89 && at(1, 'PNG')) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (at(0, 'GIF8')) return 'image/gif'
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp'
  return ''
}

export async function decode(blob: Blob): Promise<HTMLImageElement> {
  const img = new Image()
  img.src = URL.createObjectURL(blob)
  await img.decode()
  return img
}

const CELL_W = 320
const CELL_H = 250

/** The pictures side by side, numbered 1…n, for the model to choose from. */
export async function contactSheet(images: (HTMLImageElement | null)[]): Promise<string> {
  const cols = Math.min(3, images.length)
  const rows = Math.ceil(images.length / 3)
  const canvas = document.createElement('canvas')
  canvas.width = cols * CELL_W
  canvas.height = rows * CELL_H
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  images.forEach((img, n) => {
    const x = (n % 3) * CELL_W
    const y = Math.floor(n / 3) * CELL_H
    if (img) {
      const pad = 8
      const k = Math.min(
        (CELL_W - pad * 2) / img.naturalWidth,
        (CELL_H - pad * 2) / img.naturalHeight,
      )
      const w = img.naturalWidth * k
      const h = img.naturalHeight * k
      ctx.drawImage(img, x + (CELL_W - w) / 2, y + (CELL_H - h) / 2, w, h)
    }
    ctx.strokeStyle = '#c9c4b8'
    ctx.strokeRect(x + 0.5, y + 0.5, CELL_W - 1, CELL_H - 1)
    ctx.fillStyle = '#d4148c'
    ctx.beginPath()
    ctx.roundRect(x + 6, y + 6, 30, 26, 6)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 18px system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(n + 1), x + 15, y + 19.5)
  })
  return canvas.toDataURL('image/jpeg', 0.85)
}

/** How a hit is listed for the model. */
export function describeHit(h: PictureHit, n: number): string {
  const kind = h.drawing ? 'line drawing' : 'photo or scan'
  const about = h.description ? ` — ${h.description}` : ''
  return `${n}. "${h.title}" (${kind}, ${h.width}×${h.height})${about}`
}

/** The credit written small under a pasted picture (CC licences ask for one). */
export const credit = (h: PictureHit) =>
  `${h.title} · ${h.artist} · ${h.license} · Wikimedia Commons`
