import { strToU8, zipSync } from 'fflate'
import { supabase } from '../lib/web/supabase'

// "Export my notebooks" for people who used the Writey website: everything they had, as one
// .writey file the desktop app imports (same format as apps/desktop/src/store/archive.rs).

async function authed(path: string): Promise<Response> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  return fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
}

function rows<T>(res: { data: unknown; error: { message: string } | null }): T[] {
  if (res.error) throw new Error(res.error.message)
  return (res.data ?? []) as T[]
}

type Notebook = {
  id: string
  title: string
  sort_key: string
  created_at: string
  updated_at: string
}
type Page = {
  id: string
  notebook_id: string
  sort_key: string
  width: number
  height: number
  background: { kind: string; assetId?: string }
  version: number
}
type Thread = { id: string; notebook_id: string; title: string | null; updated_at: string }
type Message = {
  thread_id: string
  role: 'user' | 'assistant'
  content: { text?: string; mode?: string; error?: boolean }
  model: string | null
  usage: unknown
}
type Asset = {
  id: string
  kind: 'pdf' | 'image'
  bytes: number
  sha256: string
  page_count: number | null
  created_at: string
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

export async function exportEverything(progress: (text: string) => void): Promise<Blob> {
  progress('Listing your notebooks…')
  const notebooks = rows<Notebook>(
    await supabase
      .from('notebooks')
      .select('id,title,sort_key,created_at,updated_at')
      .is('deleted_at', null)
      .order('sort_key'),
  )
  const pages = rows<Page>(
    await supabase
      .from('pages')
      .select('id,notebook_id,sort_key,width,height,background,version')
      .is('deleted_at', null)
      .order('sort_key'),
  )
  const threads = rows<Thread>(
    await supabase.from('ai_threads').select('id,notebook_id,title,updated_at').order('updated_at'),
  )
  const messages = rows<Message>(
    await supabase
      .from('ai_messages')
      .select('thread_id,role,content,model,usage')
      .order('created_at'),
  )
  const assets = rows<Asset>(
    await supabase.from('assets').select('id,kind,bytes,sha256,page_count,created_at'),
  )

  const files: Record<string, Uint8Array> = {}
  const usedAssets = new Set<string>()
  const pageEntries = new Map<string, object[]>()
  let done = 0
  for (const p of pages) {
    progress(`Copying page ${++done} of ${pages.length}…`)
    const res = await authed(`/pages/${p.id}/content`)
    let content: string | null = null
    if (res.status === 200) {
      const bytes = new Uint8Array(await res.arrayBuffer())
      content = `pages/${p.id}.json.gz`
      files[content] = bytes
      const text = await new Response(
        new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
      ).text()
      for (const id of text.match(UUID) ?? []) usedAssets.add(id)
    } else if (!res.ok && res.status !== 204) {
      throw new Error(`A page didn't download (${res.status}). Try again.`)
    }
    if (p.background.assetId) usedAssets.add(p.background.assetId)
    const list = pageEntries.get(p.notebook_id) ?? []
    list.push({ ...p, content })
    pageEntries.set(p.notebook_id, list)
  }

  const assetEntries: object[] = []
  const wanted = assets.filter((a) => usedAssets.has(a.id))
  done = 0
  for (const a of wanted) {
    progress(`Copying file ${++done} of ${wanted.length}…`)
    const res = await authed(`/assets/${a.id}`)
    if (!res.ok) continue
    const file = `assets/${a.id}`
    files[file] = new Uint8Array(await res.arrayBuffer())
    const mime =
      res.headers.get('Content-Type') ?? (a.kind === 'pdf' ? 'application/pdf' : 'image/png')
    assetEntries.push({ ...a, mime, file })
  }

  const manifest = {
    format: 'writey',
    version: 1,
    exported_at: new Date().toISOString(),
    notebooks: notebooks.map((n) => ({
      ...n,
      pages: pageEntries.get(n.id) ?? [],
      threads: threads
        .filter((t) => t.notebook_id === n.id)
        .map((t) => ({
          id: t.id,
          title: t.title,
          updated_at: t.updated_at,
          messages: messages
            .filter((m) => m.thread_id === t.id)
            .map((m) => ({
              id: '',
              role: m.role,
              text: m.content.text ?? '',
              mode: m.content.mode,
              error: m.content.error,
              model: m.model,
              usage: m.usage ?? null,
            })),
        })),
    })),
    assets: assetEntries,
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  progress('Packing the file…')
  // Ink is gzipped already and PDFs/images are compressed: store them as they are.
  const zipped = zipSync(
    Object.fromEntries(
      Object.entries(files).map(([k, v]) => [k, [v, { level: k === 'manifest.json' ? 6 : 0 }]]),
    ),
  )
  return new Blob([zipped as BlobPart], { type: 'application/zip' })
}
