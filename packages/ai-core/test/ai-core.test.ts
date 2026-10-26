import { describe, expect, it } from 'vitest'
import {
  type Block,
  chatBody,
  chatEvents,
  decide,
  describeError,
  focusRegion,
  groupLines,
  inkMode,
  messageText,
  type PageContext,
  parseModels,
  parsePlan,
  planMessages,
  produceMessages,
  produceSystem,
  routeIntent,
  type StreamEvent,
  sseData,
} from '../src'

const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s))
      c.close()
    },
  })

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('routeIntent', () => {
  it.each([
    ["Writey, what's next?", 'write', 'next_step'],
    ["Hey, what's next?", 'write', 'next_step'],
    ['explain the full adder circuit', 'explain', null],
    ['continue', 'write', 'next_step'],
    ['solve this', 'write', 'full'],
    ['show me the full solution', 'write', 'full'],
    ['why does this work?', 'explain', null],
    ["I don't understand step 2", 'explain', null],
    ['what is a derivative', 'explain', null],
    ['is this right?', 'check', null],
    ['did I make a mistake', 'check', null],
    ['how do I start this one', 'explain', 'hint'],
    ['give me a hint', null, 'hint'],
    ['just explain, please continue', 'chat', 'next_step'],
    ["explain it, don't write anything", 'chat', null],
    ['write it', 'write', null],
    ['draw a free body diagram', 'write', null],
    ['make a truth table for XOR', 'write', null],
    ['sketch the graph of sin x', 'write', null],
    ['label the parts of this diagram', 'write', null],
    ['circle my mistake', 'check', null],
    ['where is the resistor in this circuit', 'explain', null],
    ['hmm', null, null],
  ])('%s → %s / %s', (text, mode, scope) => {
    expect(routeIntent(text)).toEqual({ mode, scope })
  })
})

describe('groupLines and focusRegion', () => {
  const ink = (id: string, x: number, y: number, w = 40, h = 18): Block => ({
    id,
    rect: { x, y, w, h },
    kind: 'ink',
  })
  const page = { width: 595, height: 842 }

  it('groups strokes on the same baseline, dots included', () => {
    const lines = groupLines([
      ink('a', 50, 100),
      ink('b', 100, 102),
      ink('dot', 160, 96, 3, 3),
      ink('c', 50, 140),
    ])
    expect(lines.map((l) => [...l.ids].sort())).toEqual([['a', 'b', 'dot'], ['c']])
  })

  it('focuses on recent lines plus everything contiguous above and the problem block', () => {
    const blocks = [
      ink('old1', 50, 40), // an earlier problem, far above
      ink('prob', 50, 200), // the problem statement
      ink('w1', 50, 280), // work starts after a gap
      ink('w2', 50, 305),
      ink('w3', 50, 330),
    ]
    const focus = focusRegion(blocks, { page, recent: new Set(['w3']) })
    expect(focus.lines.map((l) => l.ids)).toEqual([['prob'], ['w1'], ['w2'], ['w3']])
    expect(focus.lines.map((l) => l.label)).toEqual(['L1', 'L2', 'L3', 'L4'])
    expect(focus.rect.y).toBeLessThan(200)
    expect(focus.rect.y).toBeGreaterThan(58)
  })

  it('uses the last block of work when nothing is recent', () => {
    const blocks = [ink('a', 50, 100), ink('b', 50, 400), ink('c', 50, 425)]
    const focus = focusRegion(blocks, { page, recent: new Set() })
    expect(focus.lines.flatMap((l) => l.ids)).toEqual(['a', 'b', 'c'])
  })

  it('lets a lasso selection win', () => {
    const blocks = [ink('a', 50, 100), ink('b', 50, 400)]
    const focus = focusRegion(blocks, {
      page,
      recent: new Set(['b']),
      selection: { x: 40, y: 90, w: 100, h: 40 },
    })
    expect(focus.lines.map((l) => l.ids)).toEqual([['a']])
  })

  it('shows the whole page when there is no handwriting', () => {
    const pdf: Block = { id: 'p', rect: { x: 50, y: 50, w: 400, h: 12 }, kind: 'pdf' }
    const focus = focusRegion([pdf], { page, recent: new Set() })
    expect(focus.rect).toEqual({ x: 0, y: 0, w: 595, h: 842 })
    expect(focus.lines).toEqual([])
  })

  it('stays inside the page', () => {
    const focus = focusRegion([ink('a', 2, 2, 20, 10)], { page, recent: new Set(['a']) })
    expect(focus.rect.x).toBe(0)
    expect(focus.rect.y).toBe(0)
    expect(focus.rect.w).toBeGreaterThanOrEqual(200)
  })
})

describe('streaming', () => {
  it('splits SSE across chunk boundaries and skips comments', async () => {
    const data = await collect(sseData(stream(': ping\n\nda', 'ta: {"a":1}\n\ndata: [DONE]\n\n')))
    expect(data).toEqual(['{"a":1}', '[DONE]'])
  })

  it('yields text, reasoning and usage, and stops at [DONE]', async () => {
    const events = await collect(
      chatEvents(
        stream(
          'data: {"choices":[{"delta":{"reasoning":"hmm"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"there"}}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"cost":0.001}}\n\n',
          'data: [DONE]\n\ndata: {"choices":[{"delta":{"content":"late"}}]}\n\n',
        ),
      ),
    )
    expect(events).toEqual<StreamEvent[]>([
      { type: 'reasoning', text: 'hmm' },
      { type: 'text', text: 'Hi ' },
      { type: 'text', text: 'there' },
      { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } },
    ])
  })

  it('surfaces mid-stream errors', async () => {
    const events = await collect(
      chatEvents(stream('data: {"error":{"message":"overloaded","code":502}}\n\n')),
    )
    expect(events).toEqual([{ type: 'error', message: 'overloaded', status: 502 }])
  })

  it('reads non-streamed replies', () => {
    expect(messageText({ choices: [{ message: { content: '{"a":1}' } }] })).toBe('{"a":1}')
  })

  it('only sends reasoning effort to OpenRouter', () => {
    const req = { model: 'm', messages: [], maxTokens: 10, stream: true, reasoning: 'low' as const }
    expect(JSON.parse(chatBody('openrouter', req)).reasoning).toEqual({ effort: 'low' })
    expect(JSON.parse(chatBody('opencode-zen', req)).reasoning).toBeUndefined()
  })
})

describe('plan', () => {
  it('parses fenced JSON and repairs bad fields', () => {
    const plan = parsePlan(
      'Sure!\n```json\n{"problem":"integrate x e^x","mode":"draw","scope":"full","target_line":"l4","status_line":"On step 2"}\n```',
    )
    expect(plan).toEqual({
      problem: 'integrate x e^x',
      user_progress: '',
      mode: 'explain',
      scope: 'full',
      target_line: 'L4',
      status_line: 'On step 2',
    })
    expect(parsePlan('no json here')).toBeNull()
  })

  it('lets the wording override the plan', () => {
    const plan = parsePlan('{"mode":"write","scope":"full"}')
    expect(decide({ mode: 'explain', scope: null }, plan)).toMatchObject({
      mode: 'explain',
      scope: 'full',
    })
    expect(decide({ mode: null, scope: null }, null)).toMatchObject({ mode: 'explain' })
  })
})

describe('prompts', () => {
  const ctx: PageContext = {
    focusImage: 'data:image/png;base64,AAA',
    pageImage: 'data:image/png;base64,BBB',
    labels: ['L1', 'L2'],
    typedText: [],
    pdfText: 'Find the derivative of x^2',
    selection: false,
  }

  it('sends both images and the page text to PLAN', () => {
    const [system, user] = planMessages('what next', ctx, { mode: 'write', scope: null }, [])
    expect(system?.role).toBe('system')
    const parts = user?.content as { type: string }[]
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(2)
    expect(JSON.stringify(parts)).toContain('Find the derivative')
    expect(JSON.stringify(parts)).toContain('mode \\"write\\"')
  })

  it('keeps only the last 10 turns of history for PRODUCE', () => {
    const turns = Array.from({ length: 14 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      text: `t${i}`,
    }))
    const plan = decide({ mode: null, scope: 'hint' }, null)
    const msgs = produceMessages('hint?', ctx, plan, turns)
    expect(msgs).toHaveLength(1 + 10 + 1)
    expect(msgs[1]?.content).toBe('t4')
    expect(String(msgs[0]?.content)).toMatch(/hint only/i)
  })

  it('asks for InkScript whenever Writey has the pen, Markdown for chat', () => {
    expect(produceSystem('write', 'next_step')).toContain('InkScript')
    expect(produceSystem('check', 'next_step')).toContain('"type":"mark"')
    expect(produceSystem('write', 'next_step')).toContain('"latex":"\\\\frac{d}{dx}')
    expect(produceSystem('chat', 'next_step')).toContain('Answer in Markdown')
    expect(produceSystem('explain', 'next_step')).toContain('InkScript')
    expect(produceSystem('explain', 'next_step')).toContain('page lines first')
    expect(inkMode('both')).toBe(true)
    expect(inkMode('explain')).toBe(true)
    expect(inkMode('chat')).toBe(false)
  })

  it('passes Writey’s own ink and the spoken transcript', () => {
    const msgs = produceMessages(
      'next',
      { ...ctx, aiInk: ['$$x=2$$'], transcript: 'so this is the chain rule' },
      decide({ mode: 'write', scope: null }, null),
      [],
    )
    const text = JSON.stringify(msgs.at(-1)?.content)
    expect(text).toContain('$$x=2$$')
    expect(text).toContain('chain rule')
  })
})

describe('describeError', () => {
  it('maps common failures to plain messages', () => {
    expect(describeError('openrouter', 'm', 400, '{"error":"no_key"}')).toEqual({
      message: 'Add your OpenRouter key in Settings to ask Writey.',
      settings: true,
    })
    expect(describeError('openrouter', 'm', 401, '{"error":{"message":"nope"}}').settings).toBe(
      true,
    )
    expect(describeError('opencode-zen', 'm', 402, '').message).toContain('out of credits')
    expect(describeError('openrouter', 'm', 429, '').message).toContain('rate limiting')
    expect(
      describeError(
        'openrouter',
        'm',
        400,
        '{"error":{"message":"No endpoints support image input"}}',
      ).message,
    ).toContain("can't read images")
  })
})

describe('parseModels', () => {
  it('marks OpenRouter vision models', () => {
    const models = parseModels('openrouter', {
      data: [
        { id: 'b/text', name: 'B', architecture: { input_modalities: ['text'] } },
        { id: 'a/vis', name: 'A', architecture: { input_modalities: ['text', 'image'] } },
      ],
    })
    expect(models.map((m) => [m.id, m.vision])).toEqual([
      ['a/vis', true],
      ['b/text', false],
    ])
  })

  it('flags Zen models Writey cannot call', () => {
    const models = parseModels('opencode-zen', {
      data: [{ id: 'deepseek-v4.1-flash' }, { id: 'gpt-6-sol' }, { id: 'glm-5.3-flash-free' }],
    })
    const byId = Object.fromEntries(models.map((m) => [m.id, m]))
    expect(byId['deepseek-v4.1-flash']).toMatchObject({ supported: true, vision: true })
    expect(byId['gpt-6-sol']?.supported).toBe(false)
    expect(byId['glm-5.3-flash-free']?.supported).toBe(false)
  })
})
