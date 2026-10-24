import type { Item, PageDoc } from './model'

const round2 = (n: number) => Math.round(n * 100) / 100

/** Compact JSON: coordinates to 0.01 pt, timestamps to whole ms. */
export function encodePage(doc: PageDoc): string {
  const items = doc.items.map((item) => {
    if (item.kind !== 'stroke') return item
    const points = item.points.map((n, i) => (i % 3 === 2 ? Math.round(n) : round2(n)))
    return { ...item, points }
  })
  return JSON.stringify({ v: 1, items })
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const isStr = (s: unknown): s is string => typeof s === 'string'

function validItem(raw: unknown): raw is Item {
  if (!raw || typeof raw !== 'object') return false
  const i = raw as Record<string, unknown>
  if (!isStr(i.id)) return false
  switch (i.kind) {
    case 'stroke':
      return (
        (i.tool === 'pen' || i.tool === 'highlighter') &&
        isStr(i.color) &&
        isNum(i.width) &&
        Array.isArray(i.points) &&
        i.points.length >= 3 &&
        i.points.length % 3 === 0 &&
        i.points.every(isNum)
      )
    case 'image':
      return isStr(i.assetId) && [i.x, i.y, i.w, i.h].every(isNum)
    case 'text':
      return isStr(i.text) && isStr(i.color) && [i.x, i.y, i.w, i.h, i.size].every(isNum)
    default:
      return false
  }
}

/** Parses a stored page. Unknown or malformed items are dropped rather than failing the page. */
export function decodePage(json: string): PageDoc {
  const raw = JSON.parse(json) as { v?: unknown; items?: unknown }
  if (raw.v !== 1 || !Array.isArray(raw.items)) throw new Error('Unsupported page format')
  return {
    v: 1,
    items: raw.items
      .filter(validItem)
      .map((i) => (i.kind === 'stroke' && !i.author ? { ...i, author: 'user' } : i)),
  }
}

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function gunzip(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}
