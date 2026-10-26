import type { KeyProvider } from '@writey/shared'

// OpenAI Chat Completions, which OpenRouter and OpenCode Zen both speak (docs §6.1).

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** A tool the model called, with its arguments as JSON text. */
export type ToolCall = { id: string; name: string; arguments: string }

/** A tool the model may call (JSON Schema parameters). */
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> }

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  /** Assistant turns: the tools it called. */
  toolCalls?: ToolCall[]
  /** Tool results: the call they answer. */
  toolCallId?: string
  /** Assistant turns: the provider's reasoning, handed back so the model keeps its thread. */
  reasoning?: unknown[]
}

export type Usage = {
  prompt_tokens?: number
  completion_tokens?: number
  /** Of prompt_tokens, how many came from the provider's prompt cache (cheap and fast). */
  cached_tokens?: number
  cost?: number
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: Usage }
  /** A complete tool call. */
  | { type: 'tool'; call: ToolCall }
  /** Reasoning to hand back with the next request (OpenRouter details, Responses items). */
  | { type: 'thought'; item: unknown }
  /**
   * The stream failed. Codes "length" (cut off at the token limit), "interrupted" (the
   * connection dropped) and "incomplete" mean the model can carry on from what it sent.
   */
  | { type: 'error'; message: string; status?: number; code?: string }

/** How hard the model thinks before it answers. */
export type Effort = 'none' | 'low' | 'medium' | 'high'

export type ChatRequest = {
  model: string
  messages: ChatMessage[]
  maxTokens: number
  stream: boolean
  /** OpenRouter only; other providers ignore it. */
  reasoning?: Effort
  tools?: readonly ToolSpec[]
  /** "none" makes the model answer in words even though tools are on offer. */
  toolChoice?: 'auto' | 'none'
}

/** Messages in Chat Completions wire format. */
function wireMessages(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    }
    if (m.role === 'assistant' && (m.toolCalls?.length || m.reasoning?.length)) {
      return {
        role: 'assistant',
        content: typeof m.content === 'string' ? m.content : m.content,
        ...(m.toolCalls?.length && {
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        }),
        ...(m.reasoning?.length && { reasoning_details: m.reasoning }),
      }
    }
    return { role: m.role, content: m.content }
  })
}

export function chatBody(provider: KeyProvider, req: ChatRequest): string {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: wireMessages(req.messages),
    max_tokens: req.maxTokens,
    stream: req.stream,
  }
  if (req.stream) body.stream_options = { include_usage: true }
  if (provider === 'openrouter' && req.reasoning) body.reasoning = { effort: req.reasoning }
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: t }))
    if (req.toolChoice) body.tool_choice = req.toolChoice
  }
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
  choices?: {
    delta?: {
      content?: unknown
      reasoning?: unknown
      reasoning_content?: unknown
      reasoning_details?: unknown
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: Usage
  error?: { message?: string; code?: number }
}

type Detail = Record<string, unknown> & { index?: number; text?: string; summary?: string }

/** Turns a streamed Chat Completions response into text, reasoning, tool and usage events. */
export async function* chatEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  // Tool calls stream in pieces by index; each is complete once the next one starts.
  const calls: ToolCall[] = []
  let sent = 0
  // Some providers send no call ids; made-up ones must not repeat across requests.
  const stamp = Math.random().toString(36).slice(2, 8)
  let finished: string | undefined
  let done = false
  const details: Detail[] = []
  const finish = function* (all: boolean): Generator<StreamEvent> {
    const until = all ? calls.length : calls.length - 1
    for (; sent < until; sent++) {
      const c = calls[sent] as ToolCall
      if (c.name) {
        yield {
          type: 'tool',
          call: {
            id: c.id || `call_${stamp}_${sent}`,
            name: c.name,
            arguments: c.arguments || '{}',
          },
        }
      }
    }
    if (all) for (const d of details.splice(0)) yield { type: 'thought', item: d }
  }
  for await (const data of sseData(body)) {
    if (data === '[DONE]') {
      done = true
      break
    }
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
    if (Array.isArray(delta?.reasoning_details)) {
      // Pieces of one reasoning block share an index: join their text.
      for (const d of delta.reasoning_details as Detail[]) {
        const same = details.find((x) => x.index === d.index && x.type === d.type)
        if (!same) details.push({ ...d })
        else {
          if (typeof d.text === 'string') same.text = (same.text ?? '') + d.text
          if (typeof d.summary === 'string') same.summary = (same.summary ?? '') + d.summary
          for (const [k, v] of Object.entries(d))
            if (k !== 'text' && k !== 'summary' && v) same[k] = v
        }
      }
    }
    if (typeof delta?.content === 'string' && delta.content) {
      yield { type: 'text', text: delta.content }
    }
    for (const t of delta?.tool_calls ?? []) {
      let i = t.index ?? Math.max(0, calls.length - 1)
      // A new id at an index that already holds a whole call is a new call (some providers
      // send every call at index 0).
      const at = calls[i]
      if (at && t.id && at.id && t.id !== at.id) i = calls.length
      if (!calls[i]) calls[i] = { id: '', name: '', arguments: '' }
      const c = calls[i] as ToolCall
      if (t.id) c.id = t.id
      if (t.function?.name) c.name += t.function.name
      if (t.function?.arguments) c.arguments += t.function.arguments
      yield* finish(false)
    }
    const reason = chunk.choices?.[0]?.finish_reason
    if (reason) finished = reason
    if (chunk.usage) {
      const { prompt_tokens_details: d, ...u } = chunk.usage as Usage & {
        prompt_tokens_details?: { cached_tokens?: number }
      }
      yield { type: 'usage', usage: { ...u, cached_tokens: d?.cached_tokens } }
    }
  }
  yield* finish(true)
  if (finished === 'length') {
    yield { type: 'error', code: 'length', message: 'The answer was cut off at the length limit.' }
  } else if (!done && !finished) {
    yield {
      type: 'error',
      code: 'interrupted',
      message: 'The connection dropped before the model finished.',
    }
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
  cached_tokens: (a?.cached_tokens ?? 0) + (b?.cached_tokens ?? 0),
  cost: (a?.cost ?? 0) + (b?.cost ?? 0),
})
