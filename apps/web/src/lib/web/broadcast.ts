// Broadcasts state changes to other open tabs so they can refresh stale caches.

export type BroadcastMessage =
  | { type: 'notebooks_changed' }
  | { type: 'pages_changed'; notebookId: string }
  | { type: 'page_saved'; notebookId: string; pageId: string }

const CHANNEL_NAME = 'writey-web-sync'

let channel: BroadcastChannel | null = null

function getChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null
  if (!channel) {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME)
    } catch {
      channel = null
    }
  }
  return channel
}

export function broadcastMessage(msg: BroadcastMessage): void {
  try {
    getChannel()?.postMessage(msg)
  } catch {}
}

export function onBroadcastMessage(callback: (msg: BroadcastMessage) => void): () => void {
  const ch = getChannel()
  if (!ch) return () => {}
  const handler = (event: MessageEvent<BroadcastMessage>) => {
    if (event.data && typeof event.data === 'object' && 'type' in event.data) {
      callback(event.data)
    }
  }
  ch.addEventListener('message', handler)
  return () => {
    ch.removeEventListener('message', handler)
  }
}
