import { useEffect } from 'react'
import { isDesktop } from '../native'

/** Subscribe to focus + interval refresh; returns a cleanup (for tests). */
export function startRemoteRefresh(onRefresh: () => void, intervalMs = 30_000): () => void {
  if (isDesktop()) return () => {}
  const run = () => onRefresh()
  window.addEventListener('focus', run)
  const timer = window.setInterval(run, intervalMs)
  return () => {
    window.removeEventListener('focus', run)
    window.clearInterval(timer)
  }
}

/** While the website is open, pick up notebooks and ink the desktop app synced up. */
export function useRemoteRefresh(onRefresh: () => void, intervalMs = 30_000): void {
  useEffect(() => startRemoteRefresh(onRefresh, intervalMs), [onRefresh, intervalMs])
}
