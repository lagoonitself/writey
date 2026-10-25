import type { KeyProvider } from '@writey/shared'

// OpenAI Chat Completions, which OpenRouter and OpenCode Zen both speak (docs §6.1).

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

export type Usage = { prompt_tokens?: number; completion_tokens?: number; cost?: number }

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; message: string; status?: number; code?: string }

export type ChatRequest = {
  model: string
  messages: ChatMessage[]
  maxTokens: number
  stream: boolean
  /** OpenRouter only; other providers ignore it. */
  reasoning?: 'none' | 'low' | 'high'
}

export function chatBody(provider: KeyProvider, req: ChatRequest): string {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    max_tokens: req.maxTokens,
    stream: req.stream,
  }
  if (req.stream) body.stream_options = { include_usage: true }
  if (provider === 'openrouter' && req.reasoning) body.reasoning = { effort: req.reasoning }
  return JSON.stringify(body)
}

/** Splits a server-sent-events stream into its `data:` payloads. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line === '') {
          if (data.length) yield data.join('\n')
          data = []
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
        }
        nl = buffer.indexOf('\n')
      }
      if (done) {
        if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''))
        if (data.length) yield data.join('\n')
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}

type Chunk = {
  choices?: { delta?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown } }[]
  usage?: Usage
  error?: { message?: string; code?: number }
}

/** Turns a streamed Chat Completions response into text, reasoning and usage events. */
export async function* chatEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  for await (const data of sseData(body)) {
    if (data === '[DONE]') return
    let chunk: Chunk
    try {
      chunk = JSON.parse(data) as Chunk
    } catch {
      continue
    }
    if (chunk.error) {
      yield {
        type: 'error',
        message: chunk.error.message ?? 'The model stopped with an error',
        status: chunk.error.code,
      }
      return
    }
    const delta = chunk.choices?.[0]?.delta
    const reasoning = delta?.reasoning ?? delta?.reasoning_content
    if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', text: reasoning }
    if (typeof delta?.content === 'string' && delta.content) {
      yield { type: 'text', text: delta.content }
    }
    if (chunk.usage) yield { type: 'usage', usage: chunk.usage }
  }
}

/** Text of a non-streamed Chat Completions response. */
export function messageText(json: unknown): string {
  const content = (json as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
    ?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
  }
  return ''
}

export const addUsage = (a: Usage | undefined, b: Usage | undefined): Usage => ({
  prompt_tokens: (a?.prompt_tokens ?? 0) + (b?.prompt_tokens ?? 0),
  completion_tokens: (a?.completion_tokens ?? 0) + (b?.completion_tokens ?? 0),
  cost: (a?.cost ?? 0) + (b?.cost ?? 0),
})
