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
  /** Exact sources of Writey's own handwriting in the region (docs §5.1). */
  aiInk?: string[]
  /** What the student said out loud in the last 30 s (docs §7.2). */
  transcript?: string
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
  hint: 'Give a hint only, in two or three sentences: a nudge or a guiding question. Skip the step-by-step walkthrough. Do not give the answer or do the step for them.',
  next_step: 'Cover exactly one step, the next one after their last line.',
  full: 'Give the complete solution through to the final answer.',
}

/** Modes answered in handwriting on the page (HANDOFF D3). Everything else goes to chat. */
export const inkMode = (mode: Mode): mode is Exclude<Mode, 'explain'> => mode !== 'explain'

const INK_GUIDE: Record<Exclude<Mode, 'explain'>, string> = {
  write:
    'Write what comes next on the page, as the student would write it: one step per line, with "why" on each. Then add one chat block that explains, in two to four plain sentences, what you wrote and why it works, like a tutor sitting next to them.',
  check:
    'Check their lines in order. Tick the lines that are right (only the important ones). At the first mistake, circle or cross that line with a short note naming the error, then write the corrected line as math with "after" set to that line. Do not solve further. Finish with one chat block explaining the mistake.',
  both: 'Write the next step(s) on the page, then one chat block that explains the idea behind them in three to five plain sentences, with any key formula in $...$.',
}

const INK_SCOPE: Record<Scope, string> = {
  hint: 'Hint only: write one text line starting with "Hint:" that nudges them. Do not write the step or the answer.',
  next_step:
    'Write exactly one step: the one after their last line (it may take one or two lines).',
  full: 'Write the complete solution through to the final answer, and box the final answer.',
}

const INK_FORMAT = String.raw`Reply ONLY with InkScript: one JSON object per line. No prose, no Markdown, no code fences.
{"type":"math","latex":"\\frac{d}{dx}x^2 = 2x","after":"L3","why":"power rule"}
{"type":"text","text":"Let $u = x$, so $du = dx$","after":"prev","why":"choose u"}
{"type":"mark","kind":"circle","target":"L2","note":"sign error"}
{"type":"chat","text":"Markdown for the side chat, math in $...$"}
{"type":"done","summary":"one sentence on what you wrote"}

- math: one line of an equation in LaTeX. text: a short line of words, with inline math in $...$.
- mark: red pen on one of the student's lines (target is its tag). kind: circle, underline, cross, tick or arrow. note: at most six words, or leave it out.
- after: the first block names the line tag to write below (usually their last line); later blocks use "prev" to continue underneath. Writey places and sizes the handwriting itself.
- Keep every line short, like a notebook line. A long equation continues on the next math line, starting with "=". One line per block: never use align environments or \\ line breaks.
- In JSON, double every backslash ("\\frac", "\\sqrt"). Use common commands only: \\frac \\sqrt ^ _ \\int \\sum \\lim \\vec \\cdot \\times \\left( \\right) \\text{} and Greek letters. Units go in \\text{}, e.g. 5\\,\\text{m/s}.
- Add "box": true to the math line with the final answer.
- Never copy out lines the student already wrote; write only what is new.
- End with a done block.
- The conversation can span several pages of one notebook. If this page is empty, carry on from the earlier turns: the work continues at the top of this page.`

export function produceSystem(mode: Mode, scope: Scope): string {
  if (inkMode(mode)) {
    return `You are Writey, a friendly math and physics tutor who writes by hand in the student's notebook.
${SEEING}

${INK_FORMAT}

${INK_GUIDE[mode]}
${INK_SCOPE[scope]}`
  }
  return `You are Writey, a friendly math and physics tutor inside a handwritten notebook.
${SEEING}

Answer in Markdown, like a patient tutor sitting next to the student:
- Open with the key idea in one or two plain sentences.
- Then walk through it step by step. Use a numbered list for steps; give each step its math on its own line ($$…$$) and one sentence on why it holds.
- Bold the few terms that matter. Keep paragraphs short; no walls of text and no headings for short answers.
- End with a one-line takeaway, or a quick question that checks they followed.
Write every formula in LaTeX: $…$ inline, $$…$$ on its own line. Refer to the student's lines by tag ("in L3, …"). Never invent work that is not on the page.
The conversation can span several pages of the same notebook; earlier turns may be about another page.

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
  if (ctx.aiInk?.length) {
    parts.push(
      `Writey's own handwriting in the area (what it says exactly):\n${ctx.aiInk.join('\n')}`,
    )
  }
  if (ctx.transcript) parts.push(`What the student said out loud recently:\n${ctx.transcript}`)
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
