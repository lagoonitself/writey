import { ask as nativeAsk, message as nativeMessage } from '@tauri-apps/plugin-dialog'
import { isDesktop } from './native'

// Native dialogs: the system web views don't all support confirm() and alert() (macOS's
// doesn't show prompt() at all), so questions go through the OS.

export async function ask(
  text: string,
  opts: { ok?: string; cancel?: string; danger?: boolean } = {},
): Promise<boolean> {
  if (!isDesktop()) return window.confirm(text)
  return nativeAsk(text, {
    title: 'Writey',
    kind: opts.danger === false ? 'info' : 'warning',
    okLabel: opts.ok ?? 'OK',
    cancelLabel: opts.cancel ?? 'Cancel',
  })
}

export async function notify(text: string, kind: 'info' | 'error' = 'error'): Promise<void> {
  if (!isDesktop()) {
    window.alert(text)
    return
  }
  await nativeMessage(text, { title: 'Writey', kind: kind === 'error' ? 'error' : 'info' })
}
