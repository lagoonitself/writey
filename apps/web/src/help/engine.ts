import {
  addUsage,
  chatBody,
  chatEvents,
  decide,
  describeError,
  type HelpError,
  messageText,
  type Plan,
  parsePlan,
  planMessages,
  produceMessages,
  routeIntent,
  type Turn,
  type Usage,
} from '@writey/ai-core'
import type { AiSettings, PageRow } from '@writey/shared'
import { chatRequest } from '../lib/ai'
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
  const { provider, model } = settings

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

  onUpdate({ type: 'status', text: 'Looking at your work…' })
  const { ctx } = await capturePage(opts.page, opts.snapshot)
  onUpdate({ type: 'seen', image: ctx.focusImage })

  const route = routeIntent(utterance)
  const planRes = await send(
    chatBody(provider, {
      model,
      messages: planMessages(utterance, ctx, route, turns),
      maxTokens: 600,
      stream: false,
      reasoning: 'none',
    }),
  )
  const planJson = (await planRes.json()) as { usage?: Usage }
  const plan = decide(route, parsePlan(messageText(planJson)))
  let usage = addUsage(undefined, planJson.usage)
  onUpdate({ type: 'plan', plan })
  onUpdate({ type: 'status', text: plan.status_line || MODE_STATUS[plan.mode] })

  const res = await send(
    chatBody(provider, {
      model,
      messages: produceMessages(utterance, ctx, plan, turns),
      maxTokens: 8000,
      stream: true,
      reasoning: plan.scope === 'full' || plan.mode === 'check' ? 'high' : 'low',
    }),
  )
  if (!res.body) throw new HelpFailure({ message: 'The model sent an empty reply.' })
  let text = ''
  let thinking = false
  for await (const ev of chatEvents(res.body)) {
    if (ev.type === 'text') {
      text += ev.text
      onUpdate({ type: 'text', text: ev.text })
    } else if (ev.type === 'reasoning' && !thinking && !text) {
      thinking = true
      onUpdate({ type: 'thinking' })
    } else if (ev.type === 'usage') {
      usage = addUsage(usage, ev.usage)
    } else if (ev.type === 'error') {
      throw new HelpFailure(
        describeError(
          provider,
          model,
          ev.status ?? 500,
          JSON.stringify({ error: { message: ev.message } }),
        ),
      )
    }
  }
  if (!text.trim()) throw new HelpFailure({ message: 'The model sent an empty reply. Try again.' })
  return { text, plan, usage }
}
