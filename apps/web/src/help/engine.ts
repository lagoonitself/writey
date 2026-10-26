import {
  addUsage,
  agentMessages,
  type ChatMessage,
  chatBody,
  chatEvents,
  decide,
  describeChatgptError,
  describeError,
  type Effort,
  type HelpError,
  type Mode,
  type Plan,
  pageLook,
  responsesBody,
  responsesEvents,
  routeIntent,
  SentenceBuffer,
  type StreamEvent,
  type ToolCall,
  type Turn,
  type Usage,
  WRITEY_TOOLS,
  withoutImages,
} from '@writey/ai-core'
import {
  type InkBlock,
  InkWriter,
  type Look,
  sizeFromLines,
  toolBlock,
  type Written,
} from '@writey/inkscript'
import type { AiSettings, KeyProvider, PageRow } from '@writey/shared'
import { chatRequest } from '../lib/ai'
import { chatgptResponses, HelperError } from '../lib/helper'
import type { PageSnapshot } from '../notebook/tools'
import { type Capture, capturePage } from './capture'

// The help engine (docs §5, HANDOFF D46): Writey is an agent with a pen. The model sees the
// page and calls tools (point at, mark, write, draw, look at the page again, say), as many
// as it decides, in the order it decides; each call happens on the page as it arrives and
// its result goes back to the model. When it stops calling tools, its reply is the
// explanation in the margin.

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
  /** Writey's pen goes to a spot to read it. */
  | { type: 'look'; page: PageRow; look: Look }

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

/**
 * A safety stop on model requests in one answer, not a plan: the model ends its turn
 * itself by replying without tool calls.
 */
const MAX_STEPS = 40

/** How one provider is called: a stream of events, with Writey's tools offered. */
type Transport = {
  stream(messages: ChatMessage[], effort: Effort): AsyncIterable<StreamEvent>
  failure(ev: Extract<StreamEvent, { type: 'error' }>): HelpError
}

/** OpenRouter and OpenCode Zen: Chat Completions through the Worker. */
function chatCompletions(provider: KeyProvider, model: string, signal: AbortSignal): Transport {
  return {
    async *stream(messages, effort) {
      let res: Response
      try {
        res = await chatRequest(
          provider,
          chatBody(provider, {
            model,
            messages,
            maxTokens: 16000,
            stream: true,
            reasoning: effort,
            tools: WRITEY_TOOLS,
          }),
          signal,
        )
      } catch (e) {
        if (signal.aborted) throw e
        throw new HelpFailure({ message: "Couldn't reach Writey's server. Check your connection." })
      }
      if (!res.ok)
        throw new HelpFailure(describeError(provider, model, res.status, await res.text()))
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
  return {
    async *stream(messages, effort) {
      let res: Response
      try {
        res = await chatgptResponses(responsesBody(model, messages, effort, WRITEY_TOOLS), signal)
      } catch (e) {
        if (e instanceof HelperError) throw new HelpFailure(describeChatgptError(0, '', e.code))
        throw e
      }
      if (!res.ok) throw new HelpFailure(describeChatgptError(res.status, await res.text()))
      if (!res.body) throw new HelpFailure({ message: 'ChatGPT sent an empty reply.' })
      yield* responsesEvents(res.body)
    },
    failure: (ev) =>
      describeChatgptError(
        ev.status ?? 500,
        JSON.stringify({ error: { message: ev.message } }),
        ev.code,
      ),
  }
}

export async function askWritey(opts: {
  utterance: string
  page: PageRow
  snapshot: PageSnapshot
  settings: AiSettings
  turns: readonly Turn[]
  signal: AbortSignal
  /** The student is talking to Writey: it may speak while it works. */
  spoken?: boolean
  onUpdate(u: HelpUpdate): void
  /** A blank page after this one, for ink that doesn't fit. Null if none can be made. */
  nextPage(after: PageRow): Promise<PageRow | null>
  pageNumber(page: PageRow): number
  /** The page as it is now, with Writey's preview on it, for look_at_page. */
  lookAgain(page: PageRow): PageSnapshot | null
}): Promise<HelpResult> {
  const { utterance, settings, signal, onUpdate } = opts
  const transport =
    settings.provider === 'chatgpt'
      ? chatgptPlan(settings.model, signal)
      : chatCompletions(settings.provider, settings.model, signal)

  onUpdate({ type: 'status', text: 'Looking at your work…' })
  const capture = await capturePage(opts.page, opts.snapshot)
  onUpdate({ type: 'seen', image: capture.ctx.focusImage })

  // The wording only hints (hint only, words only); the model decides what to do.
  const route = routeIntent(utterance)
  const hinted = decide(route, null)
  onUpdate({ type: 'plan', plan: hinted })
  onUpdate({ type: 'status', text: 'Thinking…' })
  const effort: Effort =
    route.scope === 'hint'
      ? 'low'
      : route.mode === 'check' || route.scope === 'full'
        ? 'high'
        : 'medium'

  const agent = new Agent(transport, capture, opts)
  const out = await agent.run(
    agentMessages(utterance, capture.ctx, route, opts.turns, Boolean(opts.spoken)),
    effort,
  )
  const mode: Mode = !out.written.length
    ? 'chat'
    : out.marked
      ? 'check'
      : route.mode === 'write' || route.mode === 'both'
        ? route.mode
        : 'explain'
  return {
    text: out.text,
    plan: { ...hinted, mode },
    usage: out.usage ?? {},
    ink: out.written.length ? out.written : undefined,
    said: out.said,
  }
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
      return `**${b.target ?? 'spot'}** (${b.kind})${b.note ? `: ${b.note}` : ''}`
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

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const list = (lines: readonly string[]) => lines.map((l, i) => `${i + 1}. ${l}`).join('\n')

const pagesLabel = (numbers: readonly number[]) =>
  numbers.length > 1 ? `pages ${numbers[0]}–${numbers.at(-1)}` : `page ${numbers[0] ?? ''}`.trim()

type ToolOutcome = { result: string; look?: ChatMessage }

/** One answer: runs the model's tool calls on the page until it replies without any. */
class Agent {
  private page: PageRow
  private capture: Capture
  /** The page the capture is of; pixel coordinates only mean something there. */
  private captured: string
  private writer: InkWriter
  private readonly style: { size: number; color: string; markColor: string; seed: number }
  private looks = 0
  private onThisPage = 0
  /** Pages with a preview open (it opens on the first look or line). */
  private readonly started = new Set<string>()
  private readonly pages: PageRow[]
  /** Pages that got ink, in order. */
  private readonly inked: PageRow[] = []
  readonly written: Written[] = []
  marked = false
  private readonly onPage: string[] = []
  private readonly unwritten: string[] = []
  private readonly margin: string[] = []
  private readonly said: string[] = []
  private usage: Usage | undefined
  private thinking = false

  constructor(
    private readonly transport: Transport,
    capture: Capture,
    private readonly o: {
      page: PageRow
      signal: AbortSignal
      onUpdate(u: HelpUpdate): void
      nextPage(after: PageRow): Promise<PageRow | null>
      pageNumber(page: PageRow): number
      lookAgain(page: PageRow): PageSnapshot | null
    },
  ) {
    this.page = o.page
    this.pages = [o.page]
    this.capture = capture
    this.captured = o.page.id
    const size = sizeFromLines(capture.lines.map((l) => l.rect.h))
    this.style = {
      size,
      color: AI_INK,
      markColor: MARK_INK,
      seed: Math.floor(Math.random() * 2 ** 31),
    }
    this.writer = this.newWriter(capture)
  }

  private newWriter(c: Capture | null): InkWriter {
    const w = new InkWriter(
      c
        ? {
            page: { width: this.page.width, height: this.page.height },
            lines: c.lines,
            obstacles: c.obstacles,
            target: null,
            images: c.images,
          }
        : {
            page: { width: this.page.width, height: this.page.height },
            lines: [],
            obstacles: [],
            target: null,
          },
      { ...this.style, seed: this.style.seed + this.looks },
    )
    // Strokes keep their order on the page's timeline.
    w.time = this.writer?.time ?? 0
    return w
  }

  async run(
    first: ChatMessage[],
    effort: Effort,
  ): Promise<{ text: string; written: Written[]; marked: boolean; usage?: Usage; said?: string }> {
    let messages = first
    for (let step = 0; step < MAX_STEPS && !this.o.signal.aborted; step++) {
      let text = ''
      const calls: ToolCall[] = []
      const results: ChatMessage[] = []
      const thoughts: unknown[] = []
      let look: ChatMessage | undefined
      for await (const ev of this.transport.stream(messages, effort)) {
        if (ev.type === 'text') {
          if (!text && this.margin.length) this.o.onUpdate({ type: 'text', text: '\n\n' })
          text += ev.text
          this.o.onUpdate({ type: 'text', text: ev.text })
        } else if (ev.type === 'tool') {
          calls.push(ev.call)
          const out = await this.call(ev.call)
          results.push({ role: 'tool', toolCallId: ev.call.id, content: out.result })
          if (out.look) look = out.look
        } else if (ev.type === 'thought') thoughts.push(ev.item)
        else if (ev.type === 'reasoning' && !this.thinking) {
          this.thinking = true
          this.o.onUpdate({ type: 'thinking' })
        } else if (ev.type === 'usage') this.usage = addUsage(this.usage, ev.usage)
        else if (ev.type === 'error') throw new HelpFailure(this.transport.failure(ev))
      }
      if (text.trim()) this.margin.push(text.trim())
      if (!calls.length) break
      // Only the newest picture of the page is sent again.
      messages = [
        ...(look ? withoutImages(messages) : messages),
        { role: 'assistant', content: text, toolCalls: calls, reasoning: thoughts },
        ...results,
        ...(look ? [look] : []),
      ]
      this.o.onUpdate({ type: 'status', text: 'Thinking…' })
    }
    return this.finish()
  }

  /** Runs one tool call on the page and says what happened, for the model. */
  private async call(c: ToolCall): Promise<ToolOutcome> {
    const { onUpdate } = this.o
    if (c.name === 'look_at_page') return this.lookAtPage()
    const b = toolBlock(c.name, c.arguments)
    if (!b) return { result: `Error: unknown tool or unreadable arguments for ${c.name}.` }
    switch (b.type) {
      case 'say': {
        this.said.push(b.text)
        const buf = new SentenceBuffer()
        for (const s of [...buf.push(b.text), ...buf.flush()]) onUpdate({ type: 'say', text: s })
        return { result: 'Said.' }
      }
      case 'page':
        return (await this.turnPage(true))
          ? {
              result: `Turned to a new blank page (page ${this.o.pageNumber(this.page)}). Write at its top.`,
            }
          : { result: 'Could not add a page.' }
      case 'look': {
        const look = this.writer.look(b)
        if (!look) return { result: this.missing(b) }
        this.open()
        onUpdate({ type: 'look', page: this.page, look })
        if (b.note) onUpdate({ type: 'status', text: `${capitalize(b.note)}…` })
        return { result: 'Your pen is resting on it.' }
      }
      case 'text':
      case 'math':
      case 'mark':
      case 'diagram':
      case 'table':
        return { result: await this.ink(b) }
      default:
        return { result: 'Nothing to do.' }
    }
  }

  private missing(b: { target?: string }): string {
    const tags = this.page.id === this.captured ? this.capture.lines.map((l) => l.label) : []
    if (b.target) {
      return `Error: there is no line ${b.target} here. Lines: ${tags.join(', ') || 'none'}.`
    }
    return this.page.id === this.captured
      ? 'Error: that spot is outside the images.'
      : 'Error: this is a new page you have not looked at; call look_at_page first.'
  }

  private async lookAtPage(): Promise<ToolOutcome> {
    this.o.onUpdate({ type: 'status', text: 'Looking at the page again…' })
    const snap = this.o.lookAgain(this.page)
    if (!snap) return { result: "Error: the page isn't open right now." }
    this.capture = await capturePage(this.page, snap)
    this.captured = this.page.id
    this.looks++
    this.writer = this.newWriter(this.capture)
    const mine = new Set(this.written.flatMap((w) => w.strokes.map((s) => s.stroke.id)))
    const yours = this.capture.lines.filter((l) => l.ids.some((id) => mine.has(id)))
    return {
      result: 'Here is the page now: see the images in the next message.',
      look: pageLook(
        this.capture.ctx,
        yours.map((l) => l.label),
      ),
    }
  }

  private open(): void {
    if (this.started.has(this.page.id)) return
    this.started.add(this.page.id)
    this.o.onUpdate({ type: 'inkStart', page: this.page })
  }

  // The page filled up: carry on at the top of a fresh page after it.
  private async turnPage(asked = false): Promise<boolean> {
    if ((!this.onThisPage && !asked) || this.pages.length > MAX_NEW_PAGES) return false
    this.o.onUpdate({
      type: 'status',
      text: asked ? 'Starting a new page…' : 'Page full, turning to a new page…',
    })
    const next = await this.o.nextPage(this.page).catch(() => null)
    if (!next) return false
    this.page = next
    this.pages.push(next)
    this.onThisPage = 0
    this.writer = this.newWriter(null)
    return true
  }

  private async ink(b: InkBlock): Promise<string> {
    const { onUpdate } = this.o
    const md = blockMarkdown(b)
    let r = this.writer.write(b)
    if (r && 'noRoom' in r && b.type !== 'mark' && (await this.turnPage())) r = this.writer.write(b)
    if (!r) {
      const at = b as { target?: string; pin?: unknown }
      return at.target || at.pin ? this.missing(at) : 'Error: nothing was written (empty).'
    }
    if ('noRoom' in r) {
      this.unwritten.push(md)
      return 'Error: no room left on the page; it was not written. Put it in your explanation instead.'
    }
    if (!this.onThisPage) {
      this.inked.push(this.page)
      this.open()
    }
    this.onThisPage++
    this.written.push(r)
    if (b.type === 'mark') this.marked = true
    this.onPage.push(md)
    onUpdate({ type: 'ink', page: this.page, written: r })
    onUpdate({ type: 'status', text: 'Writing on your page…' })
    const where = this.pixels(r.rect)
    const pageNo = this.pages.length > 1 ? ` on page ${this.o.pageNumber(this.page)}` : ''
    return `Done${pageNo}${where ? `, at ${where} in image 2 pixels` : ''}.`
  }

  /** A page rect in image 2 pixels, for the model to point at its own ink. */
  private pixels(r: { x: number; y: number; w: number; h: number }): string | null {
    if (this.page.id !== this.captured) return null
    const f = this.capture.images.page
    const px = (v: number, o: number) => Math.round((v - o) * f.scale)
    return `[${px(r.x, f.x)},${px(r.y, f.y)},${px(r.x + r.w, f.x)},${px(r.y + r.h, f.y)}]`
  }

  private finish() {
    // The margin is the explanation. A copy of the page is kept for the model's history,
    // but the chat only shows that it was written (styles hide the list).
    const { written } = this
    const spoken = this.said.join(' ').trim()
    const parts: string[] = [...this.margin]
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
      const where = pagesLabel(this.inked.map(this.o.pageNumber))
      parts.push(
        `<details class="ink-copy"><summary>Written on ${where} · ${did.join(', ')}</summary>`,
        list(this.onPage),
        '</details>',
      )
    }
    if (this.unwritten.length) {
      parts.push(`**This didn't fit on the page**, so here's the rest:`, list(this.unwritten))
    }
    if (!parts.length && !spoken && !this.o.signal.aborted) {
      throw new HelpFailure({ message: 'The model sent an empty reply. Try again.' })
    }
    return {
      text: withSaid(spoken, parts.join('\n\n')),
      written,
      marked: this.marked,
      usage: this.usage,
      said: spoken || undefined,
    }
  }
}
