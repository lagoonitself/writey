import { describe, expect, it } from 'vitest'
import {
  type ChatMessage,
  describeChatgptError,
  parseModels,
  responsesBody,
  responsesEvents,
  type StreamEvent,
} from '../src'

const stream = (...events: object[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`))
      c.close()
    },
  })

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('responsesBody', () => {
  it('moves system text to instructions and maps parts to Responses input', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be Writey.' },
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
          { type: 'text', text: 'what next?' },
        ],
      },
    ]
    expect(JSON.parse(responsesBody('gpt-6', messages))).toEqual({
      model: 'gpt-6',
      instructions: 'Be Writey.',
      store: false,
      stream: true,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'earlier question' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'earlier answer' }] },
        {
          role: 'user',
          content: [
            { type: 'input_image', image_url: 'data:image/png;base64,AA', detail: 'high' },
            { type: 'input_text', text: 'what next?' },
          ],
        },
      ],
    })
  })
})

describe('responsesEvents', () => {
  it('yields text and usage, ending at response.completed', async () => {
    const events = await collect(
      responsesEvents(
        stream(
          { type: 'response.created' },
          { type: 'response.reasoning_summary_text.delta', delta: 'hmm' },
          { type: 'response.output_text.delta', delta: 'Hi ' },
          { type: 'response.output_text.delta', delta: 'there' },
          {
            type: 'response.completed',
            response: { usage: { input_tokens: 50, output_tokens: 5 } },
          },
        ),
      ),
    )
    expect(events).toEqual([
      { type: 'reasoning', text: 'hmm' },
      { type: 'text', text: 'Hi ' },
      { type: 'text', text: 'there' },
      { type: 'usage', usage: { prompt_tokens: 50, completion_tokens: 5 } },
    ])
  })

  it('reports failures with their code, and a stream that just stops', async () => {
    const failed = await collect(
      responsesEvents(
        stream({
          type: 'response.failed',
          response: {
            error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' },
          },
        }),
      ),
    )
    expect(failed).toEqual([
      { type: 'error', code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' },
    ])
    const cut = await collect(
      responsesEvents(stream({ type: 'response.output_text.delta', delta: 'a' })),
    )
    expect(cut.at(-1)).toMatchObject({ type: 'error', code: 'interrupted' })
  })
})

describe('describeChatgptError', () => {
  it('maps plan usage codes to plain messages and actions', () => {
    expect(
      describeChatgptError(429, '', 'subscription_sharing_usage_limit_exceeded'),
    ).toMatchObject({
      link: { label: 'Manage usage', url: 'https://chatgpt.com/settings/usage' },
    })
    expect(describeChatgptError(401, '{"error":"session_expired","message":"x"}').settings).toBe(
      true,
    )
    expect(describeChatgptError(0, '', 'helper_offline').message).toContain('Helper isn’t running')
    expect(describeChatgptError(503, '').message).toContain('temporarily unavailable')
  })
})

describe('parseModels for ChatGPT', () => {
  it('reads slug and display name from the Helper list', () => {
    expect(
      parseModels('chatgpt', {
        models: [{ slug: 'gpt-6', display_name: 'GPT-6', input_modalities: ['text', 'image'] }],
      }),
    ).toEqual([{ id: 'gpt-6', name: 'GPT-6', vendor: 'OpenAI', vision: true, supported: true }])
  })
})
