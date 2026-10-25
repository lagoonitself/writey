// Intent routing, rules first (docs §5.2, HANDOFF D3). Anything the rules can't decide
// is left null for the PLAN call.

/** write = ink on the page, explain = chat, check = marks + chat, both = short ink + chat. */
export type Mode = 'write' | 'explain' | 'check' | 'both'
/** Tutor vs solver (HANDOFF D2). */
export type Scope = 'hint' | 'next_step' | 'full'

export type Route = { mode: Mode | null; scope: Scope | null }

const MODE_RULES: [RegExp, Mode][] = [
  // Explicit overrides win over everything else.
  [/\b(just|only) explain\b/, 'explain'],
  [/\bwrite (it|this|that)( down| out| on the page)?\b|\bjust show me the answer\b/, 'write'],
  [/\bwhat('?s| is) next\b/, 'write'],
  [/\b(draw|sketch|plot|graph (it|this|that)|diagram|free[- ]body|new page)\b/, 'write'],
  [
    /\b(check|is (this|that|it|my \w+) (right|correct|ok)|mistakes?|wrong|error|did i (get|do) (it|this|that) right)\b/,
    'check',
  ],
  [
    /\b(why|how (does|do|is|are|did)|explain|don'?t (get|understand)|not sure (what|why|how)|what (is|are|does|do)|meaning of|confused)\b/,
    'explain',
  ],
  [/\b(continue|next|solve|show me|finish|write|keep going|carry on|go on|complete)\b/, 'write'],
]

const SCOPE_RULES: [RegExp, Scope][] = [
  [/\b(hint|nudge|how (do|should|would|can) i|where (do|should) i start|stuck)\b/, 'hint'],
  [
    /\b(solve|full solution|the answer|finish|all (the )?steps|whole (thing|problem)|complete (it|this|the))\b/,
    'full',
  ],
  [/\b(next step|what('?s| is) next|continue|next|keep going|carry on|one step)\b/, 'next_step'],
]

export function routeIntent(utterance: string): Route {
  const text = utterance
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/^\s*(hey\s+)?writey[\s,.:!]*/, '')
  const mode = MODE_RULES.find(([re]) => re.test(text))?.[1] ?? null
  const scope = SCOPE_RULES.find(([re]) => re.test(text))?.[1] ?? null
  return { mode, scope }
}
