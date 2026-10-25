import {
  addUsage,
  type ChatMessage,
  chatBody,
  chatEvents,
  decide,
  describeChatgptError,
  describeError,
  type HelpError,
  inkMode,
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
import {
  type InkBlock,
  InkScriptParser,
  InkWriter,
  sizeFromLines,
  type Written,
} from '@writey/inkscript'
import type { AiSettings, KeyProvider, PageRow } from '@writey/shared'
import { chatRequest } from '../lib/ai'
import { chatgptResponses, HelperError } from '../lib/helper'
import type { PageSnapshot } from '../notebook/tools'
import { type Capture, capturePage } from './capture'

// The help engine (docs §5): capture → PLAN (fast, JSON) → PRODUCE (streamed).
// "explain" answers stream into the chat as Markdown; "write", "check" and "both" stream
// InkScript, which is written onto the page as a ghost preview, block by block.

/** Writey's own ink, and the teacher's red pen for marks (HANDOFF D5). */
export const AI_INK = '#5b3fb5'
export const MARK_INK = '#d0342c'

export type HelpUpdate =
  | { type: 'status'; text: string }
  | { type: 'seen'; image: string }
  | { type: 'plan'; plan: Plan }
  | { type: 'thinking' }
  | { type: 'text'; text: string }
  /** Ink is about to be written: the page opens a preview. */
  | { type: 'inkStart' }
  | { type: 'ink'; written: Written }

export type HelpResult = {
  text: string
  plan: Plan
  usage: Usage
  /** Blocks written on the page; absent for chat answers. */
  ink?: Written[]
}

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
  const capture = await capturePage(opts.page, opts.snapshot)
  const { ctx } = capture
  onUpdate({ type: 'seen', image: ctx.focusImage })

  const route = routeIntent(utterance)
  const planned = await transport.complete(planMessages(utterance, ctx, route, turns))
  const plan = decide(route, parsePlan(planned.text))
  let usage = addUsage(undefined, planned.usage)
  onUpdate({ type: 'plan', plan })
  onUpdate({ type: 'status', text: plan.status_line || MODE_STATUS[plan.mode] })

  const effort = plan.scope === 'full' || plan.mode === 'check' ? 'high' : 'low'
  const produce = produceMessages(utterance, ctx, plan, turns)
  if (inkMode(plan.mode)) {
    const ink = await writeInk(transport.stream(produce, effort), {
      page: opts.page,
      capture,
      target: plan.target_line,
      onUpdate,
      failure: transport.failure,
    })
    return { text: ink.text, plan, usage: addUsage(usage, ink.usage), ink: ink.written }
  }

  let text = ''
  let thinking = false
  for await (const ev of transport.stream(produce, effort)) {
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

/** How one InkScript block reads in the chat, which keeps a copy of what was written. */
function blockMarkdown(b: InkBlock): string {
  const why = 'why' in b && b.why ? `*(${b.why})*` : ''
  switch (b.type) {
    case 'math':
      return why ? `$$${b.latex}$$\n${why}` : `$$${b.latex}$$`
    case 'text':
      return why ? `${b.text} ${why}` : b.text
    case 'mark':
      return `**${b.target}**: ${b.note ?? b.kind}`
    default:
      return ''
  }
}

async function writeInk(
  events: AsyncIterable<StreamEvent>,
  o: {
    page: PageRow
    capture: Capture
    target: string | null
    onUpdate(u: HelpUpdate): void
    failure(ev: Extract<StreamEvent, { type: 'error' }>): HelpError
  },
): Promise<{ text: string; written: Written[]; usage: Usage | undefined }> {
  const { capture, onUpdate } = o
  const writer = new InkWriter(
    {
      page: { width: o.page.width, height: o.page.height },
      lines: capture.lines,
      obstacles: capture.obstacles,
      target: o.target,
    },
    {
      size: sizeFromLines(capture.lines.map((l) => l.rect.h)),
      color: AI_INK,
      markColor: MARK_INK,
      seed: Math.floor(Math.random() * 2 ** 31),
    },
  )
  const parser = new InkScriptParser()
  const written: Written[] = []
  const onPage: string[] = []
  const unwritten: string[] = []
  const chat: string[] = []
  let summary = ''
  let usage: Usage | undefined
  let thinking = false

  const take = (b: InkBlock) => {
    if (b.type === 'status') onUpdate({ type: 'status', text: b.text })
    else if (b.type === 'chat') chat.push(b.text)
    else if (b.type === 'done') summary = b.summary ?? ''
    else {
      const md = blockMarkdown(b)
      if (unwritten.length) {
        unwritten.push(md)
        return
      }
      const r = writer.write(b)
      if (!r) return
      if ('noRoom' in r) {
        unwritten.push(md)
        return
      }
      if (!written.length) {
        onUpdate({ type: 'inkStart' })
        onUpdate({ type: 'status', text: 'Writing on your page…' })
      }
      written.push(r)
      onPage.push(md)
      onUpdate({ type: 'ink', written: r })
      onUpdate({ type: 'text', text: `${md}\n\n` })
    }
  }

  for await (const ev of events) {
    if (ev.type === 'text') for (const b of parser.push(ev.text)) take(b)
    else if (ev.type === 'reasoning' && !thinking && !written.length) {
      thinking = true
      onUpdate({ type: 'thinking' })
    } else if (ev.type === 'usage') usage = addUsage(usage, ev.usage)
    else if (ev.type === 'error') throw new HelpFailure(o.failure(ev))
  }

  const parts: string[] = []
  const marks = written.filter((w) => w.source.startsWith('[')).length
  const lines = written.length - marks
  if (written.length) {
    const did = [
      lines && `wrote ${lines} line${lines === 1 ? '' : 's'}`,
      marks && `marked ${marks} line${marks === 1 ? '' : 's'}`,
    ].filter(Boolean)
    parts.push(`*On your page: ${did.join(' and ')}.*`)
    if (summary) parts.push(summary)
    parts.push(...onPage)
  }
  if (unwritten.length) {
    parts.push(
      '**No room left on this page** for the rest. Add a page and say "continue", or read it here:',
      ...unwritten,
    )
  }
  parts.push(...chat)
  // A model that ignored the format: show what it said rather than nothing.
  if (!parts.length && parser.leftover()) parts.push(parser.leftover())
  if (!parts.length) throw new HelpFailure({ message: 'The model sent an empty reply. Try again.' })
  return { text: parts.join('\n\n'), written, usage }
}
