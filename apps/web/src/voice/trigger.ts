// Is this sentence meant for Writey? (docs §7.2, HANDOFF D14). Speech-to-text spells a
// made-up name many ways, so the match is fuzzy: clear spellings act, near misses ask.

/** Spellings that can only mean "Writey". */
const STRONG = new Set([
  'writey',
  'writy',
  'writie',
  'wrytey',
  'wrighty',
  'righty',
  'rightie',
  'rightey',
  'ritey',
  'ritie',
  'rytey',
  'raity',
  'reitey',
  'rioty',
  'riety',
  'reity',
  'righti',
  'writi',
])
/** Real words that sound like it: Writey asks "Did you mean Writey?" instead of acting. */
const WEAK = new Set([
  'ready',
  'whitey',
  'witty',
  'rightly',
  'writely',
  'rudy',
  'roddy',
  'wady',
  'reedy',
  'rhody',
])
/** Two-word mishearings, e.g. "right he, what's next". */
const WEAK_PAIRS = new Set(['right he', 'write he', 'white he', 'right e', 'write e', 'ride he'])
const LEAD = new Set(['hey', 'hi', 'ok', 'okay', 'so', 'um', 'uh', 'oh', 'and', 'yo'])

export type Address = { kind: 'strong' | 'weak'; request: string } | null

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

/** Drops the first `n` words of `text`, keeping the rest as typed (with its punctuation). */
function after(text: string, n: number): string {
  let rest = text.trim()
  for (let i = 0; i < n; i++) rest = rest.replace(/^[^A-Za-z0-9']*[A-Za-z0-9']+/, '')
  return rest.replace(/^[\s,.:;!?-]+/, '').trim()
}

/** Removes a trailing ", Writey" from a request. */
const trimEnd = (text: string) => text.replace(/[\s,]+[A-Za-z']+[\s.!?]*$/, '').trim()

export function addressed(text: string): Address {
  const w = words(text)
  if (!w.length) return null
  // The name near the start, after a filler or two ("hey", "ok so").
  let i = 0
  while (i < 2 && i < w.length - 1 && LEAD.has(w[i] as string)) i++
  const first = w[i] as string
  const pair = `${first} ${w[i + 1] ?? ''}`
  if (STRONG.has(first)) return { kind: 'strong', request: after(text, i + 1) }
  if (WEAK.has(first)) return { kind: 'weak', request: after(text, i + 1) }
  if (WEAK_PAIRS.has(pair)) return { kind: 'weak', request: after(text, i + 2) }
  // Or at the end: "what's next, Writey?"
  const last = w.at(-1) as string
  if (w.length > 1 && STRONG.has(last)) return { kind: 'strong', request: trimEnd(text) }
  return null
}

export type VoiceCommand = 'accept' | 'discard' | 'redo' | 'stop'

const COMMANDS: [RegExp, VoiceCommand][] = [
  // Speech-to-text often hears these in another tense ("scrapped that"), so allow it.
  [
    /^(keep|kept|keeps|accept|accepted|looks good|that'?s (good|right|great)|perfect)( it| that| this)?\b/,
    'accept',
  ],
  [
    /^(discard|discarded|scrap|scrapped|delete|deleted|remove|removed|erase|erased|get rid of|throw (it|that) away)( it| that| this)?\b/,
    'discard',
  ],
  [
    /^(redo|redid|redone|try (it |that )?again|do (it|that) again|again|rewrite (it|that))\b/,
    'redo',
  ],
  [/^(stop|stopped|be quiet|shut up|cancel|never ?mind|quiet)\b/, 'stop'],
]

/** Short spoken commands that act on the page instead of asking a question. */
export function voiceCommand(request: string): VoiceCommand | null {
  const text = words(request).join(' ')
  if (!text || text.split(' ').length > 5) return null
  return COMMANDS.find(([re]) => re.test(text))?.[1] ?? null
}
