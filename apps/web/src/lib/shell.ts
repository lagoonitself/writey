import { listen } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import { importNotebooks } from './archive'
import { notify } from './dialogs'
import { call, isDesktop } from './native'

/**
 * What the desktop window does differently from a browser tab: links to websites open in
 * the system browser, and .writey files opened from Explorer or Finder are imported.
 */
export function installDesktopShell(): void {
  if (!isDesktop()) return

  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a || a.hasAttribute('download')) return
    const url = new URL(a.href, location.href)
    if (url.origin === location.origin) return
    if (url.protocol === 'https:' || url.protocol === 'mailto:') {
      e.preventDefault()
      void openUrl(url.href)
    }
  })

  // Files opened before the page was ready, then any opened while it runs (the event only
  // says there are some; taking them from the list means each is imported once).
  const open = async (paths: string[]) => {
    for (const path of paths.filter((p) => p.toLowerCase().endsWith('.writey'))) {
      try {
        const r = await importNotebooks(path)
        window.dispatchEvent(new Event('writey-imported'))
        await notify(
          `Imported ${r.notebooks} notebook${r.notebooks === 1 ? '' : 's'} from ${path.split(/[\\/]/).pop()}.`,
          'info',
        )
      } catch (e) {
        await notify(`Couldn’t import ${path}: ${(e as Error).message}`)
      }
    }
  }
  const take = () => void call<string[]>('opened_files').then(open)
  take()
  void listen('app:open-files', take)
}
