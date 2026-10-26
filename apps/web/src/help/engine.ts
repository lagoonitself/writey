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
  SaySplitter,
  SentenceBuffer,
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
// When Writey is talking (spoken replies), each answer also opens with what it says out loud,
// handed out sentence by sentence so speech starts while the rest is still coming.

/** Writey's own ink, and the teacher's red pen for marks (HANDOFF D5). */
export const AI_INK = '#5b3fb5'
export const MARK_INK = '#d0342c'

export type HelpUpdate =
  | { type: 'status'; text: string }
  | { type: 'seen'; image: string }
  | { type: 'plan'; plan: Plan }
  | { type: 'thinking' }
  | { type: 'text'; text: string }
  /** One sentence to say out loud. */
  | { type: 'say'; text: string }
  /** Ink is about to be written on this page: it opens a preview. */
  | { type: 'inkStart'; page: PageRow }
  | { type: 'ink'; page: PageRow; written: Written }

export type HelpResult = {
  text: string
  plan: Plan
  usage: Usage
  /** Blocks written on the page; absent for chat answers. */
  ink?: Written[]
  /** What Writey said out loud, if anything. */
  said?: string
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
  /** The student is talking to Writey: answers open with words to say out loud. */
  spoken?: boolean
  onUpdate(u: HelpUpdate): void
  /** A blank page after this one, for ink that doesn't fit. Null if none can be made. */
  nextPage(after: PageRow): Promise<PageRow | null>
  pageNumber(page: PageRow): number
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
  const spoken = Boolean(opts.spoken)
  const produce = produceMessages(utterance, ctx, plan, turns, spoken)
  if (inkMode(plan.mode)) {
    const ink = await writeInk(transport.stream(produce, effort), {
      page: opts.page,
      capture,
      target: plan.target_line,
      onUpdate,
      nextPage: opts.nextPage,
      pageNumber: opts.pageNumber,
      failure: transport.failure,
    })
    return {
      text: ink.text,
      plan,
      usage: addUsage(usage, ink.usage),
      ink: ink.written,
      said: ink.said,
    }
  }

  let text = ''
  let said = ''
  let thinking = false
  const split = new SaySplitter()
  const sentences = new SentenceBuffer()
  const take = (part: { say: string; text: string }, last = false) => {
    said += part.say
    for (const s of [...sentences.push(part.say), ...(last ? sentences.flush() : [])]) {
      onUpdate({ type: 'say', text: s })
    }
    if (part.text) {
      text += part.text
      onUpdate({ type: 'text', text: part.text })
    }
  }
  for await (const ev of transport.stream(produce, effort)) {
    if (ev.type === 'text') {
      take(spoken ? split.push(ev.text) : { say: '', text: ev.text })
    } else if (ev.type === 'reasoning' && !thinking && !text) {
      thinking = true
      onUpdate({ type: 'thinking' })
    } else if (ev.type === 'usage') {
      usage = addUsage(usage, ev.usage)
    } else if (ev.type === 'error') {
      throw new HelpFailure(transport.failure(ev))
    }
  }
  take(split.end(), true)
  said = said.trim()
  if (!text.trim() && !said) {
    throw new HelpFailure({ message: 'The model sent an empty reply. Try again.' })
  }
  return { text: withSaid(said, text.trim()), plan, usage, said: said || undefined }
}

/** The chat shows what Writey said above the written answer. */
function withSaid(said: string, text: string): string {
  if (!said) return text
  const esc = said.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return [`<p class="said">${esc}</p>`, text].filter(Boolean).join('\n\n')
}

/** Pages Writey may add for one answer before it gives up and puts the rest in the chat. */
const MAX_NEW_PAGES = 4

/** How one written line reads in the chat, which keeps a copy of the page. */
function blockMarkdown(b: InkBlock): string {
  const why = 'why' in b && b.why ? ` *— ${b.why}*` : ''
  switch (b.type) {
    case 'math':
      return `$\\displaystyle ${b.latex}$${why}`
    case 'text':
      return `${b.text}${why}`
    case 'mark':
      return `**${b.target}** (${b.kind})${b.note ? `: ${b.note}` : ''}`
    case 'diagram':
      return `*Diagram${b.title ? `: ${b.title}` : ''}*${why}`
    case 'table': {
      const row = (r: readonly string[]) => `   | ${r.join(' | ')} |`
      const head = b.header?.length ? b.header : (b.rows[0] ?? [])
      const body = b.header?.length ? b.rows : b.rows.slice(1)
      return [
        `*Table${b.title ? `: ${b.title}` : ''}*${why}`,
        '',
        row(head),
        `   |${' --- |'.repeat(head.length)}`,
        ...body.map(row),
      ].join('\n')
    }
    default:
      return ''
  }
}

const list = (lines: readonly string[]) => lines.map((l, i) => `${i + 1}. ${l}`).join('\n')

const pagesLabel = (numbers: readonly number[]) =>
  numbers.length > 1 ? `pages ${numbers[0]}–${numbers.at(-1)}` : `page ${numbers[0] ?? ''}`.trim()

async function writeInk(
  events: AsyncIterable<StreamEvent>,
  o: {
    page: PageRow
    capture: Capture
    target: string | null
    onUpdate(u: HelpUpdate): void
    nextPage(after: PageRow): Promise<PageRow | null>
    pageNumber(page: PageRow): number
    failure(ev: Extract<StreamEvent, { type: 'error' }>): HelpError
  },
): Promise<{ text: string; written: Written[]; usage: Usage | undefined; said?: string }> {
  const { capture, onUpdate } = o
  const size = sizeFromLines(capture.lines.map((l) => l.rect.h))
  const seed = Math.floor(Math.random() * 2 ** 31)
  const style = { size, color: AI_INK, markColor: MARK_INK, seed }
  let page = o.page
  let writer = new InkWriter(
    {
      page: { width: page.width, height: page.height },
      lines: capture.lines,
      obstacles: capture.obstacles,
      target: o.target,
    },
    style,
  )
  let onThisPage = 0
  const pages = [page]
  /** Pages that got ink, in order. */
  const inked: PageRow[] = []
  const parser = new InkScriptParser()
  const written: Written[] = []
  const onPage: string[] = []
  const unwritten: string[] = []
  const chat: string[] = []
  const said: string[] = []
  let summary = ''
  let usage: Usage | undefined
  let thinking = false

  // The page filled up: carry on at the top of a fresh page after it.
  const turnPage = async (asked = false): Promise<boolean> => {
    if ((!onThisPage && !asked) || pages.length > MAX_NEW_PAGES) return false
    onUpdate({
      type: 'status',
      text: asked ? 'Starting a new page…' : 'Page full, turning to a new page…',
    })
    const next = await o.nextPage(page).catch(() => null)
    if (!next) return false
    page = next
    pages.push(next)
    onThisPage = 0
    writer = new InkWriter(
      {
        page: { width: page.width, height: page.height },
        lines: [],
        obstacles: [],
        target: null,
      },
      style,
    )
    return true
  }

  const take = async (b: InkBlock) => {
    if (b.type === 'status') onUpdate({ type: 'status', text: b.text })
    else if (b.type === 'say') {
      said.push(b.text)
      const buf = new SentenceBuffer()
      for (const s of [...buf.push(b.text), ...buf.flush()]) onUpdate({ type: 'say', text: s })
    } else if (b.type === 'chat') {
      // The explanation streams into the chat; the working goes on the page only.
      onUpdate({ type: 'text', text: `${chat.length ? '\n\n' : ''}${b.text}` })
      chat.push(b.text)
    } else if (b.type === 'done') summary = b.summary ?? ''
    else if (b.type === 'page') {
      if (!unwritten.length) await turnPage(true)
    } else {
      const md = blockMarkdown(b)
      if (unwritten.length) {
        unwritten.push(md)
        return
      }
      let r = writer.write(b)
      if (r && 'noRoom' in r && b.type !== 'mark' && (await turnPage())) r = writer.write(b)
      if (!r) return
      if ('noRoom' in r) {
        unwritten.push(md)
        return
      }
      if (!onThisPage) {
        inked.push(page)
        onUpdate({ type: 'inkStart', page })
        onUpdate({ type: 'status', text: 'Writing on your page…' })
      }
      onThisPage++
      written.push(r)
      onPage.push(md)
      onUpdate({ type: 'ink', page, written: r })
      onUpdate({ type: 'status', text: `Writing on your page… line ${written.length}` })
    }
  }

  for await (const ev of events) {
    if (ev.type === 'text') for (const b of parser.push(ev.text)) await take(b)
    else if (ev.type === 'reasoning' && !thinking && !written.length) {
      thinking = true
      onUpdate({ type: 'thinking' })
    } else if (ev.type === 'usage') usage = addUsage(usage, ev.usage)
    else if (ev.type === 'error') throw new HelpFailure(o.failure(ev))
  }

  // The chat is the explanation. A copy of the page is kept for the model's history, but
  // the chat only shows that it was written (styles hide the list).
  const spoken = said.join(' ').trim()
  const parts: string[] = []
  if (chat.length) parts.push(...chat)
  else if (summary) parts.push(summary)
  if (written.length) {
    const drawings = written.filter((w) => w.source.startsWith('[diagram')).length
    const tables = written.filter((w) => w.source.startsWith('[table')).length
    const marks = written.filter((w) => w.source.startsWith('[')).length - drawings - tables
    const lines = written.length - marks - drawings - tables
    const did = [
      lines && `${lines} line${lines === 1 ? '' : 's'}`,
      drawings && `${drawings} diagram${drawings === 1 ? '' : 's'}`,
      tables && `${tables} table${tables === 1 ? '' : 's'}`,
      marks && `${marks} mark${marks === 1 ? '' : 's'}`,
    ].filter(Boolean)
    const where = pagesLabel(inked.map(o.pageNumber))
    parts.push(
      `<details class="ink-copy"><summary>Written on ${where} · ${did.join(', ')}</summary>`,
      list(onPage),
      '</details>',
    )
  }
  if (unwritten.length) {
    parts.push(`**This didn't fit on the page**, so here's the rest:`, list(unwritten))
  }
  // A model that ignored the format: show what it said rather than nothing.
  if (!parts.length && parser.leftover()) parts.push(parser.leftover())
  if (!parts.length && !spoken) {
    throw new HelpFailure({ message: 'The model sent an empty reply. Try again.' })
  }
  return { text: withSaid(spoken, parts.join('\n\n')), written, usage, said: spoken || undefined }
}
