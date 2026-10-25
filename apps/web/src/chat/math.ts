export type MathSpan = { tex: string; display: boolean }

/** Placeholders are plain letters and digits so Markdown leaves them alone. */
export const placeholder = (i: number) => `KTXMATH${i}END`
export const PLACEHOLDER_RE = /KTXMATH(\d+)END/g

/**
 * Pulls LaTeX out of Markdown before it is parsed, so `_` and `\` inside math survive.
 * Handles $$…$$, \[…\], \(…\) and $…$, skips code, and leaves an unclosed delimiter
 * (common mid-stream) as plain text.
 */
export function extractMath(src: string): { text: string; math: MathSpan[] } {
  const math: MathSpan[] = []
  let out = ''
  let i = 0
  const take = (tex: string, display: boolean, end: number) => {
    out += placeholder(math.length)
    math.push({ tex: tex.trim(), display })
    i = end
  }
  while (i < src.length) {
    const rest = src.slice(i)
    if (rest.startsWith('```')) {
      const close = src.indexOf('```', i + 3)
      const end = close === -1 ? src.length : close + 3
      out += src.slice(i, end)
      i = end
      continue
    }
    if (rest.startsWith('`')) {
      const close = src.indexOf('`', i + 1)
      const end = close === -1 ? src.length : close + 1
      out += src.slice(i, end)
      i = end
      continue
    }
    if (rest.startsWith('\\$')) {
      out += '\\$'
      i += 2
      continue
    }
    if (rest.startsWith('$$')) {
      const close = src.indexOf('$$', i + 2)
      if (close !== -1) {
        take(src.slice(i + 2, close), true, close + 2)
        continue
      }
    } else if (rest.startsWith('\\[') || rest.startsWith('\\(')) {
      const display = rest[1] === '['
      const close = src.indexOf(display ? '\\]' : '\\)', i + 2)
      if (close !== -1) {
        take(src.slice(i + 2, close), display, close + 2)
        continue
      }
    } else if (rest.startsWith('$') && rest[1] && !/\s/.test(rest[1])) {
      const m = /^\$((?:\\\$|[^$\n`])+?)\$(?!\d)/.exec(rest)
      // "$10. Not much$" is money, not math: a bare number then a space.
      if (m?.[1] && !/\s$/.test(m[1]) && !/^\d+([.,]\d+)?[.,]?\s/.test(m[1])) {
        take(m[1], false, i + m[0].length)
        continue
      }
    }
    out += src[i]
    i++
  }
  return { text: out, math }
}
