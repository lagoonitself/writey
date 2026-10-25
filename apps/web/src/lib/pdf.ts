import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { assetBlob } from './assets'

// pdf.js is large, so it loads only when a PDF is imported or shown.
let lib: Promise<typeof import('pdfjs-dist')> | null = null

function pdfjs() {
  lib ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]).then(([m, worker]) => {
    m.GlobalWorkerOptions.workerSrc = worker.default
    return m
  })
  return lib
}

async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const m = await pdfjs()
  return m.getDocument({ data }).promise
}

/** Page sizes in PDF points. pdf.js takes ownership of `data`, so pass a copy if you need it. */
export async function pdfPageSizes(
  data: ArrayBuffer,
): Promise<{ width: number; height: number }[]> {
  const m = await pdfjs()
  const task = m.getDocument({ data })
  try {
    const doc = await task.promise
    const sizes = []
    for (let i = 1; i <= doc.numPages; i++) {
      const vp = (await doc.getPage(i)).getViewport({ scale: 1 })
      sizes.push({ width: vp.width, height: vp.height })
    }
    return sizes
  } finally {
    void task.destroy()
  }
}

// pdf.js multiplies the context's current transform by the viewport's, so a context already
// scaled to points would draw the page scaled twice (too big, cut off on the right and bottom).
function unscaled(canvas: HTMLCanvasElement): void {
  canvas.getContext('2d')?.setTransform(1, 0, 0, 1, 0, 0)
}

const docs = new Map<string, Promise<PDFDocumentProxy>>()

function pdfForAsset(assetId: string): Promise<PDFDocumentProxy> {
  let p = docs.get(assetId)
  if (!p) {
    p = assetBlob(assetId).then(async (b) => openPdf(await b.arrayBuffer()))
    p.catch(() => docs.delete(assetId))
    docs.set(assetId, p)
  }
  return p
}

/**
 * Renders one PDF page onto `canvas` (already sized) at `pxPerPt` device pixels per point.
 * Returns a cancel function; a newer render should cancel the older one.
 */
export function renderPdfPage(
  canvas: HTMLCanvasElement,
  assetId: string,
  pageNumber: number,
  pxPerPt: number,
): () => void {
  let task: RenderTask | null = null
  let cancelled = false
  void (async () => {
    const doc = await pdfForAsset(assetId)
    const page = await doc.getPage(pageNumber)
    if (cancelled) return
    unscaled(canvas)
    task = page.render({ canvas, viewport: page.getViewport({ scale: pxPerPt }) })
    await task.promise
  })().catch((e: unknown) => {
    if ((e as { name?: string })?.name !== 'RenderingCancelledException') console.error(e)
  })
  return () => {
    cancelled = true
    task?.cancel()
  }
}

/**
 * Renders the part of a PDF page starting at (x, y) points onto `canvas`, at `pxPerPt`.
 * Used to capture what Writey sees, so it resolves when drawing is finished.
 */
export async function drawPdfRegion(
  canvas: HTMLCanvasElement,
  assetId: string,
  pageNumber: number,
  pxPerPt: number,
  x: number,
  y: number,
): Promise<void> {
  const page = await (await pdfForAsset(assetId)).getPage(pageNumber)
  const viewport = page.getViewport({
    scale: pxPerPt,
    offsetX: -x * pxPerPt,
    offsetY: -y * pxPerPt,
  })
  unscaled(canvas)
  await page.render({ canvas, viewport }).promise
}

export type PdfTextLine = { text: string; x: number; y: number; w: number; h: number }

/** The page's printed text as lines, with boxes in points (top-left origin). */
export async function pdfTextLines(assetId: string, pageNumber: number): Promise<PdfTextLine[]> {
  const m = await pdfjs()
  const page = await (await pdfForAsset(assetId)).getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const lines: PdfTextLine[] = []
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue
    const t = m.Util.transform(viewport.transform, item.transform)
    const h = Math.hypot(t[2] as number, t[3] as number)
    const box = { x: t[4] as number, y: (t[5] as number) - h, w: item.width, h }
    // pdf.js splits lines into runs; glue runs that share a baseline.
    const last = lines.at(-1)
    if (last && Math.abs(last.y - box.y) < h * 0.5 && box.x >= last.x) {
      const gap = box.x - (last.x + last.w)
      last.text += (gap > h * 0.2 ? ' ' : '') + item.str
      last.w = Math.max(last.w, box.x + box.w - last.x)
      last.h = Math.max(last.h, box.h)
    } else {
      lines.push({ text: item.str, ...box })
    }
  }
  return lines
}
