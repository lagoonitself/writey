// Is this sentence meant for Writey? (docs §7.2, HANDOFF D14). The wake word is "Hey" at the
// start of a sentence: speech-to-text hears it reliably, unlike the made-up name "Writey"
// (which it spells Righty, Rioty…). "Hey Writey" works too; the name is dropped.

const WAKE = new Set(['hey', 'hay', 'heya', 'heyy'])
/** How speech-to-text spells "Writey", dropped after the wake word or accepted on their own. */
const NAME = new Set([
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
  'ridey',
  'ridy',
  'rydey',
])
const LEAD = new Set(['ok', 'okay', 'so', 'um', 'uh', 'oh', 'and'])

export type Address = { request: string } | null

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

/** "Hey, what's next?" → "what's next?"; a bare "Hey" gives an empty request. */
export function addressed(text: string): Address {
  const w = words(text)
  if (!w.length) return null
  let i = 0
  while (i < 1 && i < w.length - 1 && LEAD.has(w[i] as string)) i++
  if (WAKE.has(w[i] as string)) {
    i++
    // "hey hey", "hey Writey"
    while (i < w.length && (WAKE.has(w[i] as string) || NAME.has(w[i] as string))) i++
    return { request: after(text, i) }
  }
  if (NAME.has(w[i] as string)) return { request: after(text, i + 1) }
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
