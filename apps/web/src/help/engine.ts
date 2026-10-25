import {
  addUsage,
  type ChatMessage,
  chatBody,
  chatEvents,
  decide,
  describeChatgptError,
  describeError,
  type HelpError,
  messageText,
  type Plan,
  parsePlan,
  planMessages,
  produceMessages,
  responsesBody,
  responsesEvents,
  routeIntent,
  type StreamEvent,
  type Turn,
  type Usage,
} from '@writey/ai-core'
import type { AiSettings, KeyProvider, PageRow } from '@writey/shared'
import { chatRequest } from '../lib/ai'
import { chatgptResponses, HelperError } from '../lib/helper'
import type { PageSnapshot } from '../notebook/tools'
import { capturePage } from './capture'

// The help engine (docs §5): capture → PLAN (fast, JSON) → PRODUCE (streamed).
// In Phase 2 every answer goes to the chat panel; ink output arrives with Phase 3.

export type HelpUpdate =
  | { type: 'status'; text: string }
  | { type: 'seen'; image: string }
  | { type: 'plan'; plan: Plan }
  | { type: 'thinking' }
  | { type: 'text'; text: string }

export type HelpResult = { text: string; plan: Plan; usage: Usage }

export class HelpFailure extends Error {
  constructor(readonly help: HelpError) {
    super(help.message)
  }
}

const MODE_STATUS: Record<Plan['mode'], string> = {
  explain: 'Explaining…',
  write: 'Working out the next step…',
  check: 'Checking your work…',
  both: 'Working it out…',
}

type Effort = 'none' | 'low' | 'high'

/** How one provider is called: a short complete reply, or a stream of events. */
type Transport = {
  complete(messages: ChatMessage[]): Promise<{ text: string; usage?: Usage }>
  stream(messages: ChatMessage[], effort: Effort): AsyncIterable<StreamEvent>
  failure(ev: Extract<StreamEvent, { type: 'error' }>): HelpError
}

/** OpenRouter and OpenCode Zen: Chat Completions through the Worker. */
function chatCompletions(provider: KeyProvider, model: string, signal: AbortSignal): Transport {
  const send = async (body: string) => {
    let res: Response
    try {
      res = await chatRequest(provider, body, signal)
    } catch (e) {
      if (signal.aborted) throw e
      throw new HelpFailure({ message: "Couldn't reach Writey's server. Check your connection." })
    }
    if (!res.ok) throw new HelpFailure(describeError(provider, model, res.status, await res.text()))
    return res
  }
  return {
    async complete(messages) {
      const res = await send(
        chatBody(provider, { model, messages, maxTokens: 600, stream: false, reasoning: 'none' }),
      )
      const json = (await res.json()) as { usage?: Usage }
      return { text: messageText(json), usage: json.usage }
    },
    async *stream(messages, effort) {
      const res = await send(
        chatBody(provider, { model, messages, maxTokens: 8000, stream: true, reasoning: effort }),
      )
      if (!res.body) throw new HelpFailure({ message: 'The model sent an empty reply.' })
      yield* chatEvents(res.body)
    },
    failure: (ev) =>
      describeError(
        provider,
        model,
        ev.status ?? 500,
        JSON.stringify({ error: { message: ev.message } }),
      ),
  }
}

/** ChatGPT plan: the Responses API through Writey Helper on this computer. */
function chatgptPlan(model: string, signal: AbortSignal): Transport {
  const open = async (messages: ChatMessage[]) => {
    let res: Response
    try {
      res = await chatgptResponses(responsesBody(model, messages), signal)
    } catch (e) {
      if (e instanceof HelperError) throw new HelpFailure(describeChatgptError(0, '', e.code))
      throw e
    }
    if (!res.ok) throw new HelpFailure(describeChatgptError(res.status, await res.text()))
    if (!res.body) throw new HelpFailure({ message: 'ChatGPT sent an empty reply.' })
    return responsesEvents(res.body)
  }
  const failure = (ev: Extract<StreamEvent, { type: 'error' }>) =>
    describeChatgptError(
      ev.status ?? 500,
      JSON.stringify({ error: { message: ev.message } }),
      ev.code,
    )
  return {
    // Plan usage only streams, so a "complete" call collects the stream.
    async complete(messages) {
      let text = ''
      let usage: Usage | undefined
      for await (const ev of await open(messages)) {
        if (ev.type === 'text') text += ev.text
        else if (ev.type === 'usage') usage = ev.usage
        else if (ev.type === 'error') throw new HelpFailure(failure(ev))
      }
      return { text, usage }
    },
    async *stream(messages) {
      yield* await open(messages)
    },
    failure,
  }
}

export async function askWritey(opts: {
  utterance: string
  page: PageRow
  snapshot: PageSnapshot
  settings: AiSettings
  turns: readonly Turn[]
  signal: AbortSignal
  onUpdate(u: HelpUpdate): void
}): Promise<HelpResult> {
  const { utterance, settings, turns, signal, onUpdate } = opts
  const transport =
    settings.provider === 'chatgpt'
      ? chatgptPlan(settings.model, signal)
      : chatCompletions(settings.provider, settings.model, signal)

  onUpdate({ type: 'status', text: 'Looking at your work…' })
  const { ctx } = await capturePage(opts.page, opts.snapshot)
  onUpdate({ type: 'seen', image: ctx.focusImage })

  const route = routeIntent(utterance)
  const planned = await transport.complete(planMessages(utterance, ctx, route, turns))
  const plan = decide(route, parsePlan(planned.text))
  let usage = addUsage(undefined, planned.usage)
  onUpdate({ type: 'plan', plan })
  onUpdate({ type: 'status', text: plan.status_line || MODE_STATUS[plan.mode] })

  const effort = plan.scope === 'full' || plan.mode === 'check' ? 'high' : 'low'
  let text = ''
  let thinking = false
  for await (const ev of transport.stream(produceMessages(utterance, ctx, plan, turns), effort)) {
    if (ev.type === 'text') {
      text += ev.text
      onUpdate({ type: 'text', text: ev.text })
    } else if (ev.type === 'reasoning' && !thinking && !text) {
      thinking = true
      onUpdate({ type: 'thinking' })
    } else if (ev.type === 'usage') {
      usage = addUsage(usage, ev.usage)
    } else if (ev.type === 'error') {
      throw new HelpFailure(transport.failure(ev))
    }
  }
  if (!text.trim()) throw new HelpFailure({ message: 'The model sent an empty reply. Try again.' })
  return { text, plan, usage }
}
