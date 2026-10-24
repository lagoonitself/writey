import type { AssetKind, AssetRow } from '@writey/shared'
import { authedFetch, errorFrom } from './api'

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function uploadAsset(
  data: ArrayBuffer,
  type: string,
  kind: AssetKind,
  pageCount?: number,
): Promise<AssetRow> {
  const headers: Record<string, string> = {
    'Content-Type': type,
    'X-Content-Sha256': await sha256Hex(data),
  }
  if (pageCount) headers['X-Page-Count'] = String(pageCount)
  const res = await authedFetch(`/assets?kind=${kind}`, { method: 'POST', body: data, headers })
  if (!res.ok) throw await errorFrom(res)
  return (await res.json()) as AssetRow
}

// Asset bytes never change for an id, so fetches are cached for the session.
const blobs = new Map<string, Promise<Blob>>()

export function assetBlob(id: string): Promise<Blob> {
  let p = blobs.get(id)
  if (!p) {
    p = authedFetch(`/assets/${id}`).then(async (res) => {
      if (!res.ok) throw await errorFrom(res)
      return res.blob()
    })
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
