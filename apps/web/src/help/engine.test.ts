import type { ChatMessage } from '@writey/ai-core'
import type { PageRow } from '@writey/shared'
import { describe, expect, it, vi } from 'vitest'
import type { PageSnapshot } from '../notebook/tools'

// A fake model that answers each request with the next scripted reply, as SSE.
const replies: (string[] | Response)[] = []
const sent: ChatMessage[][] = []
const sse = (chunks: string[]) =>
  new Response(chunks.map((c) => `data: ${c}\n\n`).join('') + 'data: [DONE]\n\n')

vi.mock('../lib/ai', () => ({
  chatRequest: async (_p: string, body: string) => {
    sent.push(JSON.parse(body).messages)
    const next = replies.shift() ?? []
    return next instanceof Response ? next : sse(next)
  },
}))
vi.mock('../lib/helper', () => ({ chatgptResponses: vi.fn(), HelperError: class {} }))
vi.mock('../lib/assets', () => ({
  uploadAsset: async () => ({ id: 'asset-1' }),
  primeImage: () => {},
}))
const searched: string[] = []
vi.mock('./pictures', () => ({
  searchPictures: async (q: string) => {
    searched.push(q)
    return [1, 2].map((n) => ({
      title: `Heart ${n}`,
      url: `https://upload.wikimedia.org/x/960px-Heart${n}.svg.png`,
      width: 960,
      height: 720,
      drawing: true,
      license: 'CC BY-SA 4.0',
      artist: 'Someone',
      page: 'https://commons.wikimedia.org/wiki/File:Heart.svg',
      description: '',
    }))
  },
  pictureBlob: async () => new Blob(['png'], { type: 'image/png' }),
  decode: async () => ({ naturalWidth: 800, naturalHeight: 600 }),
  contactSheet: async () => 'data:image/jpeg;base64,SHEET',
  describeHit: (h: { title: string }, n: number) => `${n}. ${h.title}`,
  credit: (h: { title: string }) => `${h.title} · Wikimedia Commons`,
}))

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
        call(0, 'b', 'mark', { kind: 'cross', target: 'L2', note: 'sign error' }),
        call(1, 'c', 'mark', { kind: 'tick', target: 'L9' }),
        call(2, 'd', 'look_at_page', {}),
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
    expect(updates.filter((u) => u === 'ink' || u === 'inkStart')).toEqual([
      'inkStart',
      'ink',
      'ink',
    ])
    // Each result went back to the model, and the fresh page came after them.
    const second = sent[1] as ChatMessage[]
    const tools = second.filter((m) => m.role === 'tool').map((m) => m.content)
    expect(tools[0]).toMatch(/^Done \(W1\), at \[/)
    expect(tools[1]).toContain('no line L9')
    expect(JSON.stringify(second.at(-1))).toContain('base64,2')
    // The history is append-only: the first screenshot stays, so the request before is a
    // prefix of this one and the prompt cache covers it.
    expect(JSON.stringify(second)).toContain('base64,1"')
    expect(JSON.stringify(second).startsWith(JSON.stringify(sent[0]).slice(0, -1))).toBe(true)
    expect(result.plan.mode).toBe('check')
    expect(result.ink).toHaveLength(2)
    expect(result.text).toContain('The sign flips')
  })

  const ask = async (onUpdate: (u: { type: string }) => void = () => {}) => {
    const { askWritey } = await import('./engine')
    const page = { id: 'p1', width: 595, height: 842 } as PageRow
    const snapshot = {} as PageSnapshot
    return askWritey({
      utterance: 'what next?',
      page,
      snapshot,
      settings: { provider: 'openrouter', model: 'm' } as never,
      turns: [],
      signal: new AbortController().signal,
      onUpdate,
      nextPage: async () => null,
      pageNumber: () => 1,
      lookAgain: () => snapshot,
    })
  }
  const toolResults = (i: number) =>
    (sent[i] as ChatMessage[]).filter((m) => m.role === 'tool').map((m) => String(m.content))

  it('tries again after a hiccup that happened before anything came back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    sent.length = 0
    replies.push(new Response('busy', { status: 503 }), [text('All good.')])
    const run = ask()
    await vi.runAllTimersAsync()
    const result = await run
    vi.useRealTimers()
    expect(sent).toHaveLength(2)
    expect(result.text).toContain('All good.')
  })

  it('keeps tools that ran when the reply is cut off, and carries on', async () => {
    sent.length = 0
    replies.push(
      [
        call(0, 'a', 'write_math', { latex: 'x = 1' }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
      ],
      [text('Done.')],
    )
    const result = await ask()
    expect(sent).toHaveLength(2)
    expect(toolResults(1)[0]).toMatch(/^Done \(W1\)/)
    expect(toolResults(1)[0]).toContain('cut off')
    expect(result.ink).toHaveLength(1)
  })

  it("doesn't write the same thing twice, explains bad calls, and erases its own ink", async () => {
    sent.length = 0
    const updates: string[] = []
    replies.push(
      [
        call(0, 'a', 'write_math', { latex: 'x = 1' }),
        call(1, 'b', 'write_math', { latex: 'x = 1' }),
        call(2, 'c', 'write_math', {}),
        call(3, 'd', 'draw_pictures', {}),
        call(4, 'e', 'erase', { id: 'w1' }),
        call(5, 'f', 'erase', { id: 'W7' }),
      ],
      [text('Fixed.')],
    )
    const result = await ask((u) => updates.push(u.type))
    const r = toolResults(1)
    expect(r[1]).toMatch(/^Already done/)
    expect(r[2]).toContain('write_math needs lines')
    expect(r[3]).toContain('no tool "draw_pictures"')
    expect(r[4]).toBe('Erased W1.')
    expect(r[5]).toContain('Yours: none')
    expect(updates).toContain('erase')
    expect(result.ink).toBeUndefined()
  })

  it('writes every line of one write_math call, each under the one before', async () => {
    sent.length = 0
    replies.push(
      [
        call(0, 'a', 'write_math', {
          lines: ['x^2 = 4', 'x = \\pm 2'],
          after: 'L2',
          boxed: true,
        }),
      ],
      [text('Two roots.')],
    )
    const result = await ask()
    expect(sent).toHaveLength(2)
    expect(toolResults(1)[0]).toMatch(/^Line 1: Done \(W1\).*\nLine 2: Done \(W2\)/s)
    const [a, b] = result.ink ?? []
    expect(a && b && b.rect.y >= a.rect.y + a.rect.h).toBe(true)
    expect(b?.source).toContain('\\pm 2')
  })

  it('keeps the work when a later request fails for good', async () => {
    sent.length = 0
    replies.push(
      [call(0, 'b', 'write_text', { text: 'Nearly there' })],
      new Response('{"error":{"message":"No credits"}}', { status: 402 }),
    )
    const result = await ask()
    expect(result.ink).toHaveLength(1)
    expect(result.text).toContain('Writey was cut off')
  })

  it('finds a real picture, pastes it, and names its parts beside it', async () => {
    sent.length = 0
    replies.push(
      [call(0, 'a', 'find_picture', { query: 'human heart diagram' })],
      [call(0, 'b', 'place_picture', { choice: 2 })],
      // Image 1 is 2 px per point from the page's corner (see the capture mock).
      [
        call(0, 'c', 'label_parts', {
          labels: [
            { at: [300, 400], text: 'aorta' },
            { at: [700, 450], text: 'right ventricle' },
          ],
        }),
      ],
      [text('The heart has four chambers.')],
    )
    const written: { items?: { kind: string }[]; source: string }[] = []
    const result = await ask((u) => {
      if (u.type === 'ink') written.push((u as never as { written: (typeof written)[0] }).written)
    })
    expect(searched).toEqual(['human heart diagram'])
    // The contact sheet came back to the model as an image.
    expect(JSON.stringify(sent[1])).toContain('base64,SHEET')
    expect(toolResults(1)[0]).toMatch(/^Found 2 pictures/)
    expect(toolResults(2).at(-1)).toMatch(/^Pasted the picture \(W1\)/)
    expect(written[0]?.items?.map((i) => i.kind)).toEqual(['image', 'text'])
    expect(written[0]?.source).toContain('Heart 2')
    expect(toolResults(3).at(-1)).toMatch(/^Done \(W2\)/)
    expect(written[1]?.source).toContain('right ventricle')
    expect(result.text).toContain('1 picture')
    expect(result.ink).toHaveLength(2)
  })

  it('ends in one request when the pen calls and the explanation come together', async () => {
    sent.length = 0
    const explanation =
      'A NAND gate is an AND gate followed by NOT, so its output is 1 except when both inputs are 1. Check each row of the table against that rule.'
    replies.push([
      text(explanation),
      call(0, 'a', 'draw_diagram', {
        items: [
          {
            kind: 'logic',
            inputs: ['A', 'B'],
            gates: [{ id: 'g', type: 'nand', in: ['A', 'B'] }],
            outputs: { Y: 'g' },
          },
        ],
      }),
      call(1, 'b', 'draw_table', { header: ['A', 'B', 'Y'], rows: [['0', '0', '1']] }),
    ])
    const result = await ask()
    expect(sent).toHaveLength(1)
    expect(result.ink).toHaveLength(2)
    expect(result.text).toContain('AND gate followed by NOT')
  })

  it('carries on when a call in that response failed, so the model can fix it', async () => {
    sent.length = 0
    replies.push(
      [
        text(
          'Here is the gate and how it works: the output is low only when both inputs are high, which is why the table has a single 0 in it.',
        ),
        // Gates drawn as labelled boxes are refused: the model must use the logic item.
        call(0, 'a', 'draw_diagram', {
          items: [
            { kind: 'rect', at: [0, 0], w: 2, h: 1, label: 'NAND' },
            { kind: 'line', from: [-1, 0.5], to: [0, 0.5] },
          ],
        }),
        call(1, 'b', 'write_text', {
          text: 'I could not draw the circuit, so here is what each part of the circuit does and why the output behaves this way.',
        }),
        call(2, 'c', 'draw_diagram', {
          items: [{ kind: 'lens', type: 'convex', x: 0 }, { kind: 'microscope_tube' }],
        }),
      ],
      [text('Fixed.')],
    )
    const result = await ask()
    expect(sent).toHaveLength(2)
    const r = toolResults(1)
    expect(r[0]).toMatch(/^Error: these are logic gates drawn as labelled boxes/)
    expect(r[1]).toMatch(/^Error: that is \d+ characters, too long/)
    expect(r[2]).toContain('item 1 (lens) needs f')
    expect(r[2]).toContain('there is no kind "microscope_tube"')
    expect(result.ink).toBeUndefined()
  })

  it('asks for a search before a paste', async () => {
    sent.length = 0
    replies.push([call(0, 'a', 'place_picture', { choice: 1 })], [text('ok')])
    await ask()
    expect(toolResults(1)[0]).toBe('Error: call find_picture first.')
  })
})
