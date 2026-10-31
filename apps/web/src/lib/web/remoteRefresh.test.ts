import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRemoteRefresh } from './remoteRefresh'

vi.mock('../native', () => ({ isDesktop: () => false }))

describe('startRemoteRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('runs on focus and on an interval while the website is open', () => {
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('window', {
      addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
      removeEventListener: (name: string) => listeners.delete(name),
      dispatchEvent: (e: Event) => {
        listeners.get(e.type)?.()
        return true
      },
      setInterval: (fn: () => void, ms: number) => {
        return globalThis.setInterval(fn, ms)
      },
      clearInterval: (id: ReturnType<typeof setInterval>) => {
        globalThis.clearInterval(id)
      },
    })

    const onRefresh = vi.fn()
    const stop = startRemoteRefresh(onRefresh, 10_000)
    window.dispatchEvent(new Event('focus'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(onRefresh).toHaveBeenCalledTimes(2)
    stop()
    vi.advanceTimersByTime(10_000)
    expect(onRefresh).toHaveBeenCalledTimes(2)
  })
})
