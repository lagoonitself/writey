// Turning Writey's answers into something worth saying out loud (docs §7.2 step 6).

const GREEK = new Set([
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'theta',
  'lambda',
  'mu',
  'pi',
  'rho',
  'sigma',
  'tau',
  'phi',
  'omega',
  'Delta',
  'Sigma',
  'Omega',
])

const WORDS: Record<string, string> = {
  cdot: 'times',
  times: 'times',
  div: 'divided by',
  pm: 'plus or minus',
  le: 'is at most',
  leq: 'is at most',
  ge: 'is at least',
  geq: 'is at least',
  ne: 'is not equal to',
  neq: 'is not equal to',
  approx: 'is about',
  to: 'tends to',
  rightarrow: 'gives',
  Rightarrow: 'so',
  implies: 'so',
  infty: 'infinity',
  int: 'the integral of',
  sum: 'the sum of',
  sqrt: 'the square root of',
  partial: 'partial',
  nabla: 'del',
  sin: 'sine',
  cos: 'cos',
  tan: 'tan',
  ln: 'log',
  log: 'log',
  lim: 'the limit',
}

/** Reads simple LaTeX the way a tutor would say it; anything fancy is skipped. */
export function sayMath(latex: string): string {
  let s = latex
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, ' $1 over $2 ')
    s = s.replace(/\\sqrt\{([^{}]*)\}/g, ' the square root of $1 ')
  }
  s = s
    .replace(/\^\{?2\}?/g, ' squared ')
    .replace(/\^\{?3\}?/g, ' cubed ')
    .replace(/\^\{([^{}]*)\}/g, ' to the power $1 ')
    .replace(/\^(\w)/g, ' to the power $1 ')
    .replace(/_\{([^{}]*)\}/g, ' $1 ')
    .replace(/_(\w)/g, ' $1 ')
    .replace(/\\([a-zA-Z]+)/g, (_, name: string) =>
      GREEK.has(name) ? ` ${name} ` : WORDS[name] ? ` ${WORDS[name]} ` : ' ',
    )
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/=/g, ' equals ')
    .replace(/\+/g, ' plus ')
    .replace(/(\s|^)-/g, '$1minus ')
    .replace(/ - /g, ' minus ')
    .replace(/[{}\\]/g, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

/** The first paragraph or two of a Markdown answer, as plain speech (at most ~300 chars). */
export function speakable(markdown: string): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, m: string) => ` ${sayMath(m)}. `)
    .replace(/\$([^$]+)\$/g, (_, m: string) => sayMath(m))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`#>|]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  let out = ''
  for (const p of paras) {
    if (out && out.length + p.length > 300) break
    out = out ? `${out} ${p}` : p
  }
  if (out.length > 360) {
    const cut = out.slice(0, 360)
    out = cut.slice(0, Math.max(cut.lastIndexOf('. ') + 1, 200))
  }
  return out
}

/** Splits text into sentences so speech can start before the whole reply is synthesized. */
export function sentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? []).map((s) => s.trim()).filter(Boolean)
}
