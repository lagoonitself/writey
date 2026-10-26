import { type ChatMessage, type Effort, type StreamEvent, sseData } from './chat'

// The OpenAI Responses API, used for ChatGPT plan usage through the Helper (docs §6.1).
// Plan usage requires store=false and stream=true and rejects temperature,
// max_output_tokens and system-role items, so system text goes in `instructions`.

type InputPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'high' }

const textOf = (m: ChatMessage) =>
  typeof m.content === 'string'
    ? m.content
    : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')

/** Older ChatGPT models without reasoning, which reject the `reasoning` option. */
const NO_REASONING = /^(gpt-4|gpt-3|chatgpt-4)/

export function responsesBody(
  model: string,
  messages: readonly ChatMessage[],
  effort?: Effort,
): string {
  const instructions = messages
    .filter((m) => m.role === 'system')
    .map(textOf)
    .join('\n\n')
  const input = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const textType = m.role === 'assistant' ? 'output_text' : 'input_text'
      const parts: InputPart[] =
        typeof m.content === 'string'
          ? [{ type: textType, text: m.content }]
          : m.content.map((p) =>
              p.type === 'text'
                ? { type: textType, text: p.text }
                : { type: 'input_image', image_url: p.image_url.url, detail: 'high' },
            )
      return { role: m.role, content: parts }
    })
  const body: Record<string, unknown> = { model, instructions, input, store: false, stream: true }
  // A summary of the thinking streams back, so the student sees Writey is thinking.
  if (effort && effort !== 'none' && !NO_REASONING.test(model)) {
    body.reasoning = { effort, summary: 'auto' }
  }
  return JSON.stringify(body)
}

type ResponsesEvent = {
  type?: string
  delta?: unknown
  message?: unknown
  code?: unknown
  response?: {
    usage?: { input_tokens?: number; output_tokens?: number }
    error?: { code?: string; message?: string }
    incomplete_details?: { reason?: string }
  }
}

/**
 * Streamed Responses events as text, reasoning and usage. Only `response.completed`
 * means success, so a stream that ends without it is reported as an error.
 */
export async function* responsesEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  for await (const data of sseData(body)) {
    let ev: ResponsesEvent
    try {
      ev = JSON.parse(data) as ResponsesEvent
    } catch {
      continue
    }
    switch (ev.type) {
      case 'response.output_text.delta':
        if (typeof ev.delta === 'string' && ev.delta) yield { type: 'text', text: ev.delta }
        break
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (typeof ev.delta === 'string' && ev.delta) yield { type: 'reasoning', text: ev.delta }
        break
      case 'response.completed': {
        const u = ev.response?.usage
        if (u) {
          yield {
            type: 'usage',
            usage: { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens },
          }
        }
        return
      }
      case 'response.failed': {
        const err = ev.response?.error
        yield {
          type: 'error',
          code: err?.code,
          message: err?.message ?? 'ChatGPT stopped with an error',
        }
        return
      }
      case 'response.incomplete': {
        const reason = ev.response?.incomplete_details?.reason
        yield {
          type: 'error',
          code: 'incomplete',
          message: `The answer was cut short${reason ? ` (${reason})` : ''}.`,
        }
        return
      }
      case 'error':
        yield {
          type: 'error',
          code: typeof ev.code === 'string' ? ev.code : undefined,
          message: typeof ev.message === 'string' ? ev.message : 'ChatGPT stopped with an error',
        }
        return
    }
  }
  yield {
    type: 'error',
    code: 'interrupted',
    message: 'The connection dropped before ChatGPT finished.',
  }
}
