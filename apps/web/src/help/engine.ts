import {
  addUsage,
  agentMessages,
  type ChatMessage,
  chatBody,
  chatEvents,
  compactImages,
  decide,
  describeChatgptError,
  describeError,
  type Effort,
  type HelpError,
  type Mode,
  type Plan,
  pageLook,
  questionMessage,
  responsesBody,
  responsesEvents,
  routeIntent,
  SentenceBuffer,
  type StreamEvent,
  type ToolCall,
  type Turn,
  type Usage,
  WRITEY_TOOLS,
} from '@writey/ai-core'
import {
  diagramIssues,
  type InkBlock,
  InkWriter,
  type PlacedPicture,
  repairJson,
  sizeFromLines,
  toolBlock,
  toolDiagram,
  type Written,
} from '@writey/inkscript'
import type { AiSettings, KeyProvider, PageRow } from '@writey/shared'
import { chatRequest } from '../lib/ai'
import { primeImage, uploadAsset } from '../lib/assets'
import { chatgptResponses } from '../lib/chatgpt'
import { NativeError } from '../lib/native'
import type { PageSnapshot } from '../notebook/tools'
import { type Capture, capturePage } from './capture'
import {
  contactSheet,
  credit,
  decode,
  describeHit,
  type PictureHit,
  pictureBlob,
  searchPictures,
} from './pictures'

// The help engine (docs §5, HANDOFF D46): Writey is an agent with a pen. The model sees the
// page and calls tools (mark, write, draw, look at the page again, say), as many
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
  /** Writey rubs out one of its own blocks. */
  | { type: 'erase'; page: PageRow; groupId: string }

export type HelpResult = {
  text: string
  plan: Plan
  usage: Usage
  /** Blocks written on the page; absent for chat answers. */
  ink?: Written[]
  /** What Writey said out loud, if anything. */
  said?: string
  /**
   * Everything sent and received in this conversation, exactly, for the next question to
   * carry on from, so the provider's prompt cache covers all of it. Absent after a failure.
   */
  messages?: ChatMessage[]
}

export class HelpFailure extends Error {
  constructor(
    readonly help: HelpError,
    /** A hiccup (rate limit, server error, dropped connection): trying again may work. */
    readonly retry = false,
  ) {
    super(help.message)
  }
}

/**
 * A safety stop on model requests in one answer, not a plan: the model ends its turn
 * itself, usually in its first or second response. The last request offers no tools.
 */
const MAX_STEPS = 16
/** Tries of one request that failed before anything came back. */
const MAX_RETRIES = 2
/** From this many steps left, each result reminds the model to wrap up. */
const WRAP_UP = 3
/** Failed tool calls in a row before Writey suggests looking again or finishing. */
const FAIL_STREAK = 4
/**
 * Reply text this long, sent with pen calls that all worked, is the margin explanation:
 * the answer ends there instead of costing another request (HANDOFF D52).
 */
const FINAL_TEXT = 140
/** Calls whose result the model has to see before it can go on. */
const OBSERVE = new Set(['look_at_page', 'find_picture', 'place_picture'])
/** Longest line of words for the page (math in $…$ not counted); longer is an explanation. */
const PAGE_TEXT = 100

const retryable = (status: number) => status === 408 || status === 429 || status >= 500

/** Stream errors after which the model can carry on from what it already sent. */
const RESUMABLE = new Set(['length', 'interrupted', 'incomplete'])

type StreamError = Extract<StreamEvent, { type: 'error' }>

/** How one provider is called: a stream of events, with Writey's tools offered. */
type Transport = {
  /** `final`: tools stay listed (the history refers to them) but may not be called. */
  stream(messages: ChatMessage[], effort: Effort, final: boolean): AsyncIterable<StreamEvent>
  failure(ev: StreamError): HelpError
}

const failureOf = (t: Transport, ev: StreamError) =>
  new HelpFailure(
    t.failure(ev),
    RESUMABLE.has(ev.code ?? '') || (ev.status !== undefined && retryable(ev.status)),
  )

/** OpenRouter and OpenCode Zen: Chat Completions, sent by the desktop app with your key. */
function chatCompletions(provider: KeyProvider, model: string, signal: AbortSignal): Transport {
  return {
    async *stream(messages, effort, final) {
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
            toolChoice: final ? 'none' : undefined,
          }),
          signal,
        )
      } catch (e) {
        if (signal.aborted) throw e
        throw new HelpFailure(
          { message: `${(e as Error).message || "Couldn't reach the AI"}. Check your connection.` },
          true,
        )
      }
      if (!res.ok)
        throw new HelpFailure(
          describeError(provider, model, res.status, await res.text()),
          retryable(res.status),
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

/** ChatGPT plan: the Responses API, signed in by the desktop app. */
function chatgptPlan(model: string, signal: AbortSignal, cacheKey: string): Transport {
  return {
    async *stream(messages, effort, final) {
      let res: Response
      try {
        res = await chatgptResponses(
          responsesBody(
            model,
            messages,
            effort,
            WRITEY_TOOLS,
            final ? 'none' : undefined,
            cacheKey,
          ),
          signal,
        )
      } catch (e) {
        if (signal.aborted) throw e
        if (e instanceof NativeError) throw new HelpFailure(describeChatgptError(0, '', e.code))
        throw new HelpFailure(
          {
            message: `${(e as Error).message || "Couldn't reach ChatGPT"}. Check your connection.`,
          },
          true,
        )
      }
      if (!res.ok)
        throw new HelpFailure(
          describeChatgptError(res.status, await res.text()),
          retryable(res.status),
        )
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
  /**
   * The conversation as last sent (HelpResult.messages), same provider and model. The new
   * question is appended to it; without it the conversation is rebuilt from `turns`.
   */
  history?: readonly ChatMessage[]
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
      ? chatgptPlan(settings.model, signal, `writey-${opts.page.notebook_id}`)
      : chatCompletions(settings.provider, settings.model, signal)

  onUpdate({ type: 'status', text: 'Looking at your work…' })
  const capture = await capturePage(opts.page, opts.snapshot)
  onUpdate({ type: 'seen', image: capture.ctx.focusImage })

  // The wording only hints (hint only, words only); the model decides what to do.
  const route = routeIntent(utterance)
  const hinted = decide(route, null)
  onUpdate({ type: 'plan', plan: hinted })
  onUpdate({ type: 'status', text: 'Thinking…' })
  // Medium for every answer (owner, 2026-10-26).
  const effort: Effort = 'medium'

  const spoken = Boolean(opts.spoken)
  const agent = new Agent(transport, capture, opts)
  const out = await agent.run(
    opts.history?.length
      ? compactImages([...opts.history, questionMessage(utterance, capture.ctx, route, spoken)])
      : agentMessages(utterance, capture.ctx, route, opts.turns, spoken),
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
    messages: out.messages,
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
    case 'labels':
      return `*Labelled: ${b.labels.map((l) => l.text).join(', ')}*`
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

type ToolOutcome = {
  result: string
  /** The call didn't do all it was asked (an error, or part of a drawing skipped). */
  trouble?: boolean
  /** A fresh picture of the page: every older picture is dropped. */
  look?: ChatMessage
  /** A close-up or a contact sheet of pictures: only older ones are dropped. */
  zoom?: ChatMessage
}

/** One model request: what it said, the tools it called and what they did. */
type Step = {
  text: string
  calls: ToolCall[]
  results: ChatMessage[]
  thoughts: unknown[]
  look?: ChatMessage
  zooms: ChatMessage[]
  failure?: HelpFailure
  /** Some call failed or was only partly done. */
  trouble: boolean
}

const REQUIRED = new Map(
  WRITEY_TOOLS.map((t) => [t.name, (t.parameters.required as string[] | undefined) ?? []]),
)

/** Tools that put ink on the page (or speak): an identical second call is not done again. */
const ONCE = new Set([
  'mark',
  'write_math',
  'write_text',
  'draw_diagram',
  'draw_ray_diagram',
  'draw_logic_circuit',
  'draw_table',
  'label_parts',
  'place_picture',
  'say',
])

/** What is wrong with a tool call's name or arguments, said so the model can fix it. */
function argProblem(name: string, args: string): string | null {
  const required = REQUIRED.get(name)
  if (!required)
    return `Error: there is no tool "${name}". Tools: ${[...REQUIRED.keys()].join(', ')}.`
  let o: unknown
  try {
    o = JSON.parse(repairJson(args || '{}'))
  } catch {
    return `Error: the arguments for ${name} are not valid JSON (cut off?). Nothing was done; send the call again, complete and shorter.`
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    return `Error: the arguments for ${name} must be a JSON object.`
  }
  const a = o as Record<string, unknown>
  const missing = required.filter((k) => a[k] === undefined || a[k] === null || a[k] === '')
  return missing.length ? `Error: ${name} needs ${missing.join(' and ')}. Nothing was done.` : null
}

/** The same call, however its JSON was spaced. */
function callKey(c: ToolCall): string {
  try {
    return `${c.name} ${JSON.stringify(JSON.parse(repairJson(c.arguments || '{}')))}`
  } catch {
    return `${c.name} ${c.arguments}`
  }
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })

const OUT_OF_STEPS =
  'You have used all your steps for this answer. Stop calling tools now and reply with the explanation for the margin, saying briefly what is left to do if anything.'

type AgentResult = {
  text: string
  written: Written[]
  marked: boolean
  usage?: Usage
  said?: string
  messages?: ChatMessage[]
}

/** A block Writey wrote in this answer, by the id the model knows it by (W1, W2…). */
type Entry = { written: Written; page: PageRow; md: string; mark: boolean; key: string }

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
  /** Ink in this answer, by id, in the order it was written. */
  private readonly entries = new Map<string, Entry>()
  private ids = 0
  /** Calls that already put something on the page, and what they returned. */
  private readonly done = new Map<string, string>()
  private failedInARow = 0
  private readonly unwritten: string[] = []
  private readonly margin: string[] = []
  private readonly said: string[] = []
  private usage: Usage | undefined
  private thinking = false
  /** The whole conversation once the answer ended cleanly, for the next question. */
  private history: ChatMessage[] | undefined
  /** What the last find_picture showed, by its number on the contact sheet. */
  private found: PictureHit[] = []
  /** Pictures pasted in this answer, by page, so label_parts finds them after a new look. */
  private readonly pictures = new Map<string, PlacedPicture[]>()

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
    const placed = this.pictures.get(this.page.id) ?? []
    this.pictures.set(this.page.id, placed)
    w.pictures = placed
    // After a new look, the next line still follows what Writey wrote last on this page.
    const last = [...(this.entries?.values() ?? [])]
      .filter((e) => e.page === this.page && !e.md.startsWith('*Labelled'))
      .at(-1)
    if (last) w.placer.pin(last.written.rect)
    return w
  }

  get written(): Written[] {
    return [...this.entries.values()].map((e) => e.written)
  }

  async run(first: ChatMessage[], effort: Effort): Promise<AgentResult> {
    let messages = first
    let retries = 0
    for (let step = 0; step < MAX_STEPS && !this.o.signal.aborted; step++) {
      const final = step === MAX_STEPS - 1
      const ask = final ? [...messages, { role: 'user' as const, content: OUT_OF_STEPS }] : messages
      const s = await this.step(ask, effort, final)
      if (this.o.signal.aborted) break
      if (final) messages = ask
      if (s.text.trim()) this.margin.push(s.text.trim())
      if (s.failure) {
        const nothing = !s.text && !s.calls.length
        if (s.failure.retry && nothing && retries < MAX_RETRIES) {
          // Nothing happened yet: the same request again, after a pause.
          retries++
          this.o.onUpdate({ type: 'status', text: 'The model hiccuped, trying again…' })
          await wait(1500 * retries, this.o.signal)
          step--
          continue
        }
        // Tools that already ran stay done: the model carries on from their results.
        if (!s.failure.retry || !s.calls.length) return this.finish(s.failure)
      }
      const reply: ChatMessage = {
        role: 'assistant',
        content: s.text,
        toolCalls: s.calls,
        reasoning: s.thoughts,
      }
      if (!s.calls.length) {
        // The reply that ends the turn stays in the history for the next question.
        if (!s.failure && (s.text || s.thoughts.length)) this.history = [...messages, reply]
        break
      }
      // Pen calls and the explanation in one response, all done: the answer is finished.
      if (
        !s.failure &&
        !s.trouble &&
        s.text.trim().length >= FINAL_TEXT &&
        s.calls.every((c) => !OBSERVE.has(c.name))
      ) {
        this.history = [...messages, reply, ...s.results]
        break
      }
      retries = 0
      const left = MAX_STEPS - 2 - step
      const notes = [
        s.failure && `(Your reply was cut off: ${s.failure.message} Keep each call smaller.)`,
        left <= WRAP_UP &&
          `(${left === 0 ? 'No tool steps' : `${left} step${left === 1 ? '' : 's'}`} left: finish up.)`,
        this.failedInARow >= FAIL_STREAK &&
          '(Several calls in a row failed. Call look_at_page to see the page as it is now, or finish with your explanation.)',
      ].filter(Boolean)
      if (this.failedInARow >= FAIL_STREAK) this.failedInARow = 0
      const results = s.results.map((r, i) =>
        i === s.results.length - 1 && notes.length
          ? { ...r, content: `${r.content}\n${notes.join('\n')}` }
          : r,
      )
      // Append-only, like a coding agent's history, so every request starts with the last
      // one and the provider's prompt cache covers it. Old pictures go in batches.
      messages = compactImages([
        ...messages,
        reply,
        ...results,
        ...(s.look ? [s.look] : []),
        ...s.zooms,
      ])
      this.o.onUpdate({ type: 'status', text: 'Thinking…' })
    }
    return this.finish()
  }

  /** One model request, with its tool calls run on the page as they arrive. */
  private async step(messages: ChatMessage[], effort: Effort, final: boolean): Promise<Step> {
    const s: Step = { text: '', calls: [], results: [], thoughts: [], zooms: [], trouble: false }
    try {
      for await (const ev of this.transport.stream(messages, effort, final)) {
        if (ev.type === 'text') {
          if (!s.text && this.margin.length) this.o.onUpdate({ type: 'text', text: '\n\n' })
          s.text += ev.text
          this.o.onUpdate({ type: 'text', text: ev.text })
        } else if (ev.type === 'tool') {
          // The last request is for words only; a model that calls a tool anyway is ignored.
          if (final) continue
          s.calls.push(ev.call)
          const out = await this.call(ev.call)
          const failed = out.result.startsWith('Error')
          this.failedInARow = failed ? this.failedInARow + 1 : 0
          if (failed || out.trouble) s.trouble = true
          s.results.push({ role: 'tool', toolCallId: ev.call.id, content: out.result })
          if (out.look) s.look = out.look
          if (out.zoom) s.zooms.push(out.zoom)
        } else if (ev.type === 'thought') s.thoughts.push(ev.item)
        else if (ev.type === 'reasoning' && !this.thinking) {
          this.thinking = true
          this.o.onUpdate({ type: 'thinking' })
        } else if (ev.type === 'usage') this.usage = addUsage(this.usage, ev.usage)
        else if (ev.type === 'error') {
          s.failure = failureOf(this.transport, ev)
          break
        }
      }
    } catch (e) {
      if (!(e instanceof HelpFailure) || this.o.signal.aborted) throw e
      s.failure = e
    }
    return s
  }

  /** Runs one tool call on the page and says what happened, for the model. */
  private async call(c: ToolCall): Promise<ToolOutcome> {
    const problem = argProblem(c.name, c.arguments)
    if (problem) return { result: problem }
    const key = callKey(c)
    const before = ONCE.has(c.name) ? this.done.get(key) : undefined
    if (before)
      return { result: `Already done by an identical earlier call (${before}). Not repeated.` }
    try {
      const out = await this.run1(c, key)
      if (ONCE.has(c.name) && !out.result.startsWith('Error')) this.done.set(key, out.result)
      return out
    } catch (e) {
      // A bug in one tool shouldn't end the answer: the model hears about it and goes on.
      if (this.o.signal.aborted) throw e
      console.error(e)
      return { result: `Error: ${c.name} failed (${(e as Error).message}). Nothing was done.` }
    }
  }

  private async run1(c: ToolCall, key: string): Promise<ToolOutcome> {
    const { onUpdate } = this.o
    if (c.name === 'look_at_page') return this.lookAtPage()
    if (c.name === 'find_picture') {
      return this.findPicture(JSON.parse(repairJson(c.arguments || '{}')))
    }
    if (c.name === 'place_picture') {
      return this.placePicture(JSON.parse(repairJson(c.arguments || '{}')), key)
    }
    if (c.name === 'write_math') return { result: await this.writeMath(c.arguments, key) }
    if (c.name === 'draw_diagram') return this.drawDiagram(c.arguments, key)
    const special = toolDiagram(c.name, JSON.parse(repairJson(c.arguments || '{}')))
    if (special) return this.drawDiagram(JSON.stringify(special), key)
    if (c.name === 'write_text') {
      const a = JSON.parse(repairJson(c.arguments || '{}')) as { text?: unknown }
      const words = String(a.text ?? '').replace(/\$[^$]*\$/g, 'x')
      if (words.length > PAGE_TEXT) {
        return {
          result: `Error: that is ${words.length} characters, too long for a line on the page. Page text is a heading, a label or a key fact in a few words; explanations go in your reply. Nothing was written.`,
        }
      }
    }
    if (c.name === 'erase') {
      const a = JSON.parse(repairJson(c.arguments || '{}')) as { id?: unknown }
      return { result: this.erase(String(a.id ?? '')) }
    }
    const b = toolBlock(c.name, c.arguments)
    if (!b) {
      return {
        result:
          c.name === 'mark'
            ? 'Error: say where: a line tag (target), or a spot (box or at) in image pixels.'
            : `Error: couldn't use those arguments for ${c.name}. Nothing was done.`,
      }
    }
    switch (b.type) {
      case 'say': {
        this.said.push(b.text)
        const buf = new SentenceBuffer()
        for (const s of [...buf.push(b.text), ...buf.flush()]) onUpdate({ type: 'say', text: s })
        return { result: 'Said.' }
      }
      case 'page': {
        if (this.page !== this.o.page && !this.onThisPage) {
          return { result: 'You are already at the top of a fresh blank page; write there.' }
        }
        return (await this.turnPage(true))
          ? {
              result: `Turned to a new blank page (page ${this.o.pageNumber(this.page)}). Write at its top.`,
            }
          : { result: 'Error: could not add a page. Put the rest in your explanation.' }
      }
      case 'text':
      case 'math':
      case 'mark':
      case 'diagram':
      case 'table':
      case 'labels':
        return { result: await this.ink(b, key) }
      default:
        return { result: 'Nothing to do.' }
    }
  }

  /** draw_diagram, with what was wrong in the spec said plainly so the model can fix it. */
  private async drawDiagram(args: string, key: string): Promise<ToolOutcome> {
    const a = JSON.parse(repairJson(args || '{}')) as { items?: unknown; title?: unknown }
    const { problems, gateBoxes, handRays } = diagramIssues(a.items, String(a.title ?? ''))
    if (handRays) {
      return {
        result:
          'Error: this is a ray diagram drawn by hand with lines and arrows, so its rays would be guesses. Use draw_ray_diagram instead: give the lenses or mirrors (type, x, f) and the object, e.g. {"elements":[{"type":"convex_lens","x":0,"f":1.5,"label":"objective"},{"type":"convex_lens","x":8,"f":3,"label":"eyepiece"}],"object":{"x":-2,"h":0.5,"label":"AB"}}; Writey traces the rays and finds the images. If the student wants a picture of the instrument itself (tube, stage, knobs), use find_picture. Nothing was drawn.',
      }
    }
    if (gateBoxes) {
      return {
        result:
          'Error: these are logic gates drawn as labelled boxes. Use draw_logic_circuit instead, e.g. {"inputs":["A","B"],"gates":[{"id":"g1","type":"nand","in":["A","B"]}],"outputs":{"Y":"g1"}}; Writey draws the real gate symbols and the wires. Nothing was drawn.',
      }
    }
    const b = toolBlock('draw_diagram', args)
    const why = problems.length ? `: ${problems.join('; ')}` : ''
    if (!b) return { result: `Error: couldn't read that diagram${why}. Nothing was drawn.` }
    const r = await this.ink(b, key)
    if (!problems.length) return { result: r }
    if (r.startsWith('Error: nothing was drawn')) {
      return { result: `Error: nothing was drawn${why}.` }
    }
    if (r.startsWith('Error')) return { result: r }
    const id = /\((W\d+)\)/.exec(r)?.[1] ?? 'it'
    return {
      result: `${r} Part of it was skipped${why}. Erase ${id} and draw it again with that fixed.`,
      trouble: true,
    }
  }

  /** write_math: every line of `lines` (or the one `latex`), each under the one before. */
  private async writeMath(args: string, key: string): Promise<string> {
    const a = JSON.parse(repairJson(args || '{}')) as Record<string, unknown>
    const lines = (Array.isArray(a.lines) ? a.lines : [a.latex])
      .map((l) => (typeof l === 'string' ? l.trim() : ''))
      .filter(Boolean)
    if (!lines.length) return 'Error: write_math needs lines (or latex). Nothing was done.'
    const out: string[] = []
    for (const [i, latex] of lines.entries()) {
      const last = i === lines.length - 1
      const b = toolBlock(
        'write_math',
        JSON.stringify({
          latex,
          after: i === 0 ? a.after : 'prev',
          boxed: last && a.boxed === true,
          why: i === 0 ? a.why : undefined,
        }),
      )
      if (!b) continue
      const r = await this.ink(b, lines.length > 1 ? `${key} ${i}` : key)
      out.push(r)
      if (r.startsWith('Error')) break
    }
    return out.length > 1 ? out.map((r, i) => `Line ${i + 1}: ${r}`).join('\n') : (out[0] ?? '')
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

  /** Searches Wikimedia Commons and shows the model a numbered contact sheet. */
  private async findPicture(a: { query?: unknown }): Promise<ToolOutcome> {
    const { signal, onUpdate } = this.o
    const query = String(a.query ?? '').trim()
    onUpdate({ type: 'status', text: 'Looking for a picture…' })
    let hits: PictureHit[]
    try {
      hits = await searchPictures(query, signal)
    } catch (e) {
      if (signal.aborted) throw e
      return {
        result: `Error: couldn't search Wikimedia Commons (${(e as Error).message}). Draw it with draw_diagram instead.`,
      }
    }
    // Small renderings for the contact sheet (Commons serves 330 px thumbnails ready-made).
    const small = (url: string) => url.replace(/\/\d+px-/, '/330px-')
    const imgs = await Promise.all(
      hits.map((h) =>
        pictureBlob(small(h.url), signal)
          .then(decode)
          .catch(() => null),
      ),
    )
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const shown = hits.flatMap((h, i) => (imgs[i] ? [{ h, img: imgs[i] as HTMLImageElement }] : []))
    if (!shown.length) {
      return {
        result: `No pictures found for "${query}". Try other words (the figure's textbook name, or fewer words), or draw it with draw_diagram.`,
      }
    }
    this.found = shown.map((s) => s.h)
    const sheet = await contactSheet(shown.map((s) => s.img))
    return {
      result: `Found ${shown.length} pictures: see the contact sheet in the next message. Pick one with place_picture, or search again with other words.`,
      zoom: {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: sheet } },
          {
            type: 'text',
            text: `Pictures from Wikimedia Commons for "${query}", numbered as on the sheet:\n${this.found.map((h, i) => describeHit(h, i + 1)).join('\n')}\nPrefer a clear diagram that fits what the student needs; one with labels in another language or cluttered with labels is worse than an unlabelled one you label yourself. This sheet is for choosing only, not for pointing.`,
          },
        ],
      },
    }
  }

  /** Pastes a picture from the last search, then looks at it closely for labelling. */
  private async placePicture(
    a: { choice?: unknown; size?: unknown; after?: unknown; why?: unknown },
    key: string,
  ): Promise<ToolOutcome> {
    const { signal, onUpdate } = this.o
    const n = Number(a.choice)
    const hit = this.found[n - 1]
    if (!hit) {
      return {
        result: this.found.length
          ? `Error: choose a number from 1 to ${this.found.length}.`
          : 'Error: call find_picture first.',
      }
    }
    onUpdate({ type: 'status', text: 'Pasting the picture…' })
    let blob: Blob
    let img: HTMLImageElement
    try {
      blob = await pictureBlob(hit.url, signal)
      img = await decode(blob)
    } catch (e) {
      if (signal.aborted) throw e
      return { result: "Error: that picture couldn't be downloaded. Pick another." }
    }
    if (!/^image\/(png|jpeg|webp|gif)$/.test(blob.type)) blob = await asPng(img)
    const asset = await uploadAsset(await blob.arrayBuffer(), blob.type, 'image')
    primeImage(asset.id, img)
    const after = typeof a.after === 'string' ? a.after : undefined
    const spec = {
      assetId: asset.id,
      width: img.naturalWidth,
      height: img.naturalHeight,
      after: /^l\d+$/i.test(after ?? '')
        ? after?.toUpperCase()
        : after === 'prev'
          ? 'prev'
          : undefined,
      size: (['small', 'medium', 'large'] as const).find((s) => s === a.size),
      credit: credit(hit),
      source: `[picture: ${hit.title}] from Wikimedia Commons, ${hit.license}`,
    }
    let r = this.writer.picture(spec)
    if (r && 'noRoom' in r && (await this.turnPage())) r = this.writer.picture(spec)
    if (!r || 'noRoom' in r) {
      return { result: 'Error: no room left for the picture. Try size "small", or new_page first.' }
    }
    const id = this.record(r, `*Picture: ${hit.title}*`, false, key)
    const rect = r.items?.[0] ?? r.rect
    // Image 1 becomes the picture itself, big, so the model can point at its parts.
    const snap = this.o.lookAgain(this.page)
    if (!snap) return { result: `Pasted (${id}).` }
    this.capture = await capturePage(this.page, {
      ...snap,
      selection: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    })
    this.captured = this.page.id
    this.looks++
    this.writer = this.newWriter(this.capture)
    const [w, h] = this.capture.ctx.imageSizes?.focus ?? [0, 0]
    return {
      result: `Pasted the picture (${id}). Image 1 is now the picture itself (${w}×${h} px), in the next message.`,
      look: pageLook(
        this.capture.ctx,
        [],
        `Image 1 is now the picture you pasted, ${w}×${h} px; image 2 is the whole page. To name its parts, call label_parts with a point on each part in image 1 pixels.`,
      ),
    }
  }

  private erase(raw: string): string {
    const id = raw.trim().toUpperCase()
    const e = this.entries.get(id)
    if (!e) {
      const mine = [...this.entries.keys()]
      return `Error: there is no ${raw || 'id'} in this answer. Yours: ${mine.join(', ') || 'none'}.`
    }
    this.entries.delete(id)
    this.done.delete(e.key)
    if (e.page === this.page) {
      this.writer.free(e.written.rect)
      this.onThisPage--
    }
    this.o.onUpdate({ type: 'erase', page: e.page, groupId: e.written.groupId })
    return `Erased ${id}.`
  }

  private open(): void {
    if (this.started.has(this.page.id)) return
    this.started.add(this.page.id)
    this.o.onUpdate({ type: 'inkStart', page: this.page })
  }

  // The page filled up: carry on at the top of a fresh page after it.
  private async turnPage(asked = false): Promise<boolean> {
    // A block that doesn't fit a fresh blank page won't fit the next one either.
    const blank = this.page !== this.o.page && !this.onThisPage
    if ((blank && !asked) || this.pages.length > MAX_NEW_PAGES) return false
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

  private async ink(b: InkBlock, key: string): Promise<string> {
    const md = blockMarkdown(b)
    let r = this.writer.write(b)
    if (r && 'noRoom' in r && b.type !== 'mark' && (await this.turnPage())) r = this.writer.write(b)
    if (!r) {
      const at = b as { target?: string; pin?: unknown }
      if (at.target || at.pin) return this.missing(at)
      if (b.type === 'labels') return this.missing({})
      return b.type === 'diagram'
        ? "Error: nothing was drawn: check the items' kinds and coordinates."
        : b.type === 'table'
          ? 'Error: the table has no cells.'
          : 'Error: nothing was written (empty).'
    }
    if ('noRoom' in r) {
      this.unwritten.push(md)
      return 'Error: no room left on the page; it was not written. Put it in your explanation instead.'
    }
    const id = this.record(r, md, b.type === 'mark', key)
    const where = this.pixels(r.rect)
    const pageNo = this.pages.length > 1 ? ` on page ${this.o.pageNumber(this.page)}` : ''
    return `Done (${id})${pageNo}${where ? `, at ${where} in image 2 pixels` : ''}.`
  }

  /** Puts a written block in the preview and gives it its id. */
  private record(r: Written, md: string, mark: boolean, key: string): string {
    this.open()
    this.onThisPage++
    const id = `W${++this.ids}`
    this.entries.set(id, { written: r, page: this.page, md, mark, key })
    this.o.onUpdate({ type: 'ink', page: this.page, written: r })
    this.o.onUpdate({ type: 'status', text: 'Writing on your page…' })
    return id
  }

  /** A page rect in image 2 pixels, for the model to point at its own ink. */
  private pixels(r: { x: number; y: number; w: number; h: number }): string | null {
    if (this.page.id !== this.captured) return null
    const f = this.capture.images.page
    const px = (v: number, o: number) => Math.round((v - o) * f.scale)
    return `[${px(r.x, f.x)},${px(r.y, f.y)},${px(r.x + r.w, f.x)},${px(r.y + r.h, f.y)}]`
  }

  /**
   * The answer as it stands. After a failure, whatever is already on the page and in the
   * margin is kept, with a note; a failure before anything happened is thrown.
   */
  private finish(failure?: HelpFailure): AgentResult {
    // The margin is the explanation. A copy of the page is kept for the model's history,
    // but the chat only shows that it was written (styles hide the list).
    const entries = [...this.entries.values()]
    const written = entries.map((e) => e.written)
    const spoken = this.said.join(' ').trim()
    if (failure && !written.length && !this.margin.length && !spoken) throw failure
    const parts: string[] = [...this.margin]
    if (written.length) {
      const count = (tag: string) => written.filter((w) => w.source.startsWith(tag)).length
      const drawings = count('[diagram')
      const tables = count('[table')
      const pictures = count('[picture')
      const named = count('[labels')
      const marks = count('[') - drawings - tables - pictures - named
      const lines = written.length - marks - drawings - tables - pictures - named
      const did = [
        lines && `${lines} line${lines === 1 ? '' : 's'}`,
        pictures && `${pictures} picture${pictures === 1 ? '' : 's'}`,
        drawings && `${drawings} diagram${drawings === 1 ? '' : 's'}`,
        tables && `${tables} table${tables === 1 ? '' : 's'}`,
        marks && `${marks} mark${marks === 1 ? '' : 's'}`,
      ].filter(Boolean)
      const inked = [...new Set(entries.map((e) => e.page))]
      const where = pagesLabel(inked.map(this.o.pageNumber))
      parts.push(
        `<details class="ink-copy"><summary>Written on ${where} · ${did.join(', ')}</summary>`,
        list(entries.map((e) => e.md)),
        '</details>',
      )
    }
    if (this.unwritten.length) {
      parts.push(`**This didn't fit on the page**, so here's the rest:`, list(this.unwritten))
    }
    if (failure) parts.push(`*Writey was cut off: ${failure.help.message}*`)
    if (!parts.length && !spoken && !this.o.signal.aborted) {
      throw new HelpFailure({ message: 'The model sent an empty reply. Try again.' })
    }
    return {
      text: withSaid(spoken, parts.join('\n\n')),
      written,
      marked: entries.some((e) => e.mark),
      usage: this.usage,
      said: spoken || undefined,
      messages: failure ? undefined : this.history,
    }
  }
}

/** A picture as PNG, for formats the asset store doesn't take (SVG, AVIF…). */
async function asPng(img: HTMLImageElement): Promise<Blob> {
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  ;(c.getContext('2d') as CanvasRenderingContext2D).drawImage(img, 0, 0)
  return new Promise((resolve, reject) =>
    c.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('could not convert the picture'))),
      'image/png',
    ),
  )
}
