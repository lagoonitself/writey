import type { ChatMessage } from '@writey/ai-core'
import type { PageRow } from '@writey/shared'
import { describe, expect, it, vi } from 'vitest'
import type { PageSnapshot } from '../notebook/tools'

// A fake model that answers each request with the next scripted reply, as SSE.
const replies: string[][] = []
const sent: ChatMessage[][] = []
const sse = (chunks: string[]) =>
  new Response(chunks.map((c) => `data: ${c}\n\n`).join('') + 'data: [DONE]\n\n')

vi.mock('../lib/ai', () => ({
  chatRequest: async (_p: string, body: string) => {
    sent.push(JSON.parse(body).messages)
    return sse(replies.shift() ?? [])
  },
}))
vi.mock('../lib/helper', () => ({ chatgptResponses: vi.fn(), HelperError: class {} }))

const line = (label: string, y: number) => ({
  label,
  rect: { x: 60, y, w: 200, h: 24 },
  ids: [`s${label}`],
})
let captures = 0
vi.mock('./capture', () => ({
  capturePage: async () => {
    captures++
    const lines = captures === 1 ? [line('L1', 100), line('L2', 140)] : [line('L1', 100)]
    return {
      lines,
      obstacles: lines.map((l) => l.rect),
      focusRect: { x: 0, y: 0, w: 595, h: 842 },
      images: { focus: { x: 0, y: 0, scale: 2 }, page: { x: 0, y: 0, scale: 1 } },
      ctx: {
        focusImage: `data:image/png;base64,${captures}`,
        pageImage: 'data:image/png;base64,P',
        labels: lines.map((l) => l.label),
        typedText: [],
        pdfText: '',
        selection: false,
      },
    }
  },
}))

const call = (index: number, id: string, name: string, args: object) =>
  JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [{ index, id, function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  })
const text = (t: string) => JSON.stringify({ choices: [{ delta: { content: t } }] })

describe('askWritey', () => {
  it('runs the tools the model calls, in its order, until it stops calling them', async () => {
    const { askWritey } = await import('./engine')
    replies.push(
      [
        call(0, 'a', 'point_at', { target: 'L2', note: 'checking the sign' }),
        call(1, 'b', 'mark', { kind: 'cross', target: 'L2', note: 'sign error' }),
        call(2, 'c', 'point_at', { target: 'L9', note: 'nothing here' }),
        call(3, 'd', 'look_at_page', {}),
      ],
      [call(0, 'e', 'write_math', { latex: 'x = -2', boxed: true })],
      [text('The sign flips when you divide by $-1$.')],
    )
    const page = { id: 'p1', width: 595, height: 842 } as PageRow
    const snapshot = {} as PageSnapshot
    const updates: string[] = []
    const result = await askWritey({
      utterance: 'find my mistake',
      page,
      snapshot,
      settings: { provider: 'openrouter', model: 'm' } as never,
      turns: [],
      signal: new AbortController().signal,
      onUpdate: (u) => updates.push(u.type),
      nextPage: async () => null,
      pageNumber: () => 1,
      lookAgain: () => snapshot,
    })
    // Three model requests: the model ended the turn itself by replying with text.
    expect(sent).toHaveLength(3)
    expect(updates.filter((u) => u === 'look' || u === 'ink' || u === 'inkStart')).toEqual([
      'inkStart',
      'look',
      'ink',
      'ink',
    ])
    // Each result went back to the model, and the fresh page came after them.
    const second = sent[1] as ChatMessage[]
    const tools = second.filter((m) => m.role === 'tool').map((m) => m.content)
    expect(tools[0]).toBe('Your pen is resting on it.')
    expect(tools[1]).toMatch(/^Done, at \[/)
    expect(tools[2]).toContain('no line L9')
    expect(JSON.stringify(second.at(-1))).toContain('base64,2')
    // The first screenshot is dropped once there is a newer one.
    expect(JSON.stringify(second)).not.toContain('base64,1"')
    expect(result.plan.mode).toBe('check')
    expect(result.ink).toHaveLength(2)
    expect(result.text).toContain('The sign flips')
  })
})
