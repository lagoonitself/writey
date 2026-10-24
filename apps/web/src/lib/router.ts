import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()

function subscribe(cb: () => void) {
  listeners.add(cb)
  window.addEventListener('popstate', cb)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('popstate', cb)
  }
}

export function navigate(path: string): void {
  if (path === location.pathname) return
  history.pushState(null, '', path)
  for (const l of listeners) l()
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname)
}
