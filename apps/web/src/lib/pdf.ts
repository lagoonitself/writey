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
