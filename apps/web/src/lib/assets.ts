import type { AssetKind, AssetRow } from '@writey/shared'
import { callBytes, callForBytes } from './native'

// Imported PDFs and images, kept as files in Writey's data folder.

export function uploadAsset(
  data: ArrayBuffer,
  type: string,
  kind: AssetKind,
  pageCount?: number,
): Promise<AssetRow> {
  const headers: Record<string, string> = { 'x-kind': kind, 'x-mime': type }
  if (pageCount) headers['x-page-count'] = String(pageCount)
  return callBytes<AssetRow>('asset_add', data, headers)
}

// Asset bytes never change for an id, so reads are cached for the session.
const blobs = new Map<string, Promise<Blob>>()

export function assetBlob(id: string): Promise<Blob> {
  let p = blobs.get(id)
  if (!p) {
    p = callForBytes('asset_read', { id }).then((bytes) => new Blob([bytes as BlobPart]))
    p.catch(() => blobs.delete(id))
    blobs.set(id, p)
  }
  return p
}

const images = new Map<string, Promise<HTMLImageElement>>()

export function loadImage(id: string): Promise<HTMLImageElement> {
  let p = images.get(id)
  if (!p) {
    p = assetBlob(id).then(
      (blob) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = () => reject(new Error(`image ${id} failed to decode`))
          img.src = URL.createObjectURL(blob)
        }),
    )
    p.catch(() => images.delete(id))
    images.set(id, p)
  }
  return p
}

/** Seeds the cache with a picture Writey just saved, so it shows without reading it back. */
export function primeImage(id: string, img: HTMLImageElement): void {
  images.set(id, Promise.resolve(img))
}
