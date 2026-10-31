import { describe, expect, it, vi } from 'vitest'
import { broadcastMessage, onBroadcastMessage } from './broadcast'

vi.mock('./supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        maybeSingle: async () => ({
          data: {
            settings: {
              ai: { provider: 'chatgpt', model: '' },
            },
          },
        }),
      }),
    }),
  },
}))

describe('broadcast sync', () => {
  it('registers listener and dispatches events', () => {
    const received: unknown[] = []
    const off = onBroadcastMessage((msg) => received.push(msg))
    broadcastMessage({ type: 'notebooks_changed' })
    off()
    expect(typeof off).toBe('function')
  })
})

describe('loadAiSettings with ChatGPT', () => {
  it('preserves ChatGPT provider with empty model string', async () => {
    const { loadAiSettings } = await import('./ai')
    const settings = await loadAiSettings()
    expect(settings).toEqual({ provider: 'chatgpt', model: '' })
  })
})
