import type { ChatMessage, ContentPart } from './chat'
import type { Mode, Route, Scope } from './intent'
import type { Plan } from './plan'

/** What the help engine captured from the page for one request. */
export type PageContext = {
  /** Data URL: the focus region with line tags drawn on. */
  focusImage: string
  /** Data URL: the whole page, small, with the focus region outlined. */
  pageImage: string
  labels: string[]
  /** Typed text boxes inside the focus region. */
  typedText: string[]
  /** PDF text inside the focus region. */
  pdfText: string
  /** True when the region came from a lasso selection. */
  selection: boolean
}

export type Turn = { role: 'user' | 'assistant'; text: string }

/** Turns sent with each request (docs §5.8). */
export const HISTORY_TURNS = 10

const SEEING = `You are looking at a student's handwritten notebook page.
- Image 1 is the area they are working on. Each line of their writing has a magenta tag (L1, L2, …) on its left. The tags are not part of their work; use them to refer to lines.
- Image 2 is the whole page, small, with that area outlined in magenta.
Read the handwriting carefully. If a line is unreadable, say so instead of guessing.`

export const PLAN_SYSTEM = `You are Writey, a math and physics tutor inside a handwritten notebook.
${SEEING}

Work out what the student is doing and how to help. Reply with ONE JSON object and nothing else:
{"problem":"…","user_progress":"…","mode":"explain","scope":"next_step","target_line":"L3","status_line":"…"}

- problem: the problem being solved, one sentence. Math in LaTeX between $…$.
- user_progress: what they have done and where they are now, one sentence.
- mode: "write" if they want the next step(s) written out, "explain" if they want something explained, "check" if they want their work checked, "both" for a short step plus an explanation. If unsure, "explain".
- scope: "hint" for a nudge only, "next_step" for exactly one step, "full" for the complete solution.
- target_line: the line the request is about (e.g. "L3"), else their last line, or null if the page is empty.
- status_line: at most 12 words, spoken to the student, saying what you see. Example: "Integration by parts — you're on step 2".`

const MODE_GUIDE: Record<Mode, string> = {
  explain: 'Explain what they asked about, tied to their own lines.',
  write:
    'Write out what comes next as they would write it: one step per line, each with a short reason.',
  check:
    'Check their lines in order. Say which are right. At the first mistake, name the line, say what is wrong and give the fix. Do not solve further than needed.',
  both: 'Give the next step written out, then a short explanation of why.',
}

const SCOPE_GUIDE: Record<Scope, string> = {
  hint: 'Give a hint only: a nudge or a guiding question. Do not give the answer or do the step for them.',
  next_step: 'Cover exactly one step, the next one after their last line.',
  full: 'Give the complete solution through to the final answer.',
}

export function produceSystem(mode: Mode, scope: Scope): string {
  return `You are Writey, a friendly math and physics tutor inside a handwritten notebook.
${SEEING}

Answer in Markdown. Write every formula in LaTeX: $…$ inline, $$…$$ on its own line.
Be brief and concrete. Refer to the student's lines by tag ("in L3, …"). Never invent work that is not on the page.

${MODE_GUIDE[mode]}
${SCOPE_GUIDE[scope]}`
}

function pageText(ctx: PageContext): string {
  const parts: string[] = []
  parts.push(
    ctx.labels.length
      ? `Lines in the area: ${ctx.labels.join(', ')}.`
      : 'There is no handwriting in the area.',
  )
  if (ctx.selection) parts.push('The student lassoed this area on purpose.')
  if (ctx.typedText.length) parts.push(`Typed text in the area:\n${ctx.typedText.join('\n')}`)
  if (ctx.pdfText) parts.push(`Printed (PDF) text in the area:\n${ctx.pdfText}`)
  return parts.join('\n\n')
}

const images = (ctx: PageContext): ContentPart[] => [
  { type: 'image_url', image_url: { url: ctx.focusImage } },
  { type: 'image_url', image_url: { url: ctx.pageImage } },
]

function history(turns: readonly Turn[]): ChatMessage[] {
  return turns.slice(-HISTORY_TURNS).map((t) => ({ role: t.role, content: t.text }))
}

export function planMessages(
  utterance: string,
  ctx: PageContext,
  route: Route,
  turns: readonly Turn[],
): ChatMessage[] {
  const hints = [
    route.mode && `The wording suggests mode "${route.mode}".`,
    route.scope && `The wording suggests scope "${route.scope}".`,
  ].filter(Boolean)
  const recent = turns
    .slice(-4)
    .map((t) => `${t.role === 'user' ? 'Student' : 'Writey'}: ${t.text.slice(0, 300)}`)
    .join('\n')
  return [
    { role: 'system', content: PLAN_SYSTEM },
    {
      role: 'user',
      content: [
        ...images(ctx),
        {
          type: 'text',
          text: [
            pageText(ctx),
            recent && `Recent conversation:\n${recent}`,
            `The student said: "${utterance}"`,
            ...hints,
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    },
  ]
}

export function produceMessages(
  utterance: string,
  ctx: PageContext,
  plan: Plan,
  turns: readonly Turn[],
): ChatMessage[] {
  const planText = [
    plan.problem && `Problem: ${plan.problem}`,
    plan.user_progress && `Where they are: ${plan.user_progress}`,
    plan.target_line && `Line in question: ${plan.target_line}`,
  ]
    .filter(Boolean)
    .join('\n')
  return [
    { role: 'system', content: produceSystem(plan.mode, plan.scope) },
    ...history(turns),
    {
      role: 'user',
      content: [
        ...images(ctx),
        {
          type: 'text',
          text: [pageText(ctx), planText, `The student said: "${utterance}"`]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    },
  ]
}
