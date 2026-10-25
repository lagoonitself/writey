import { GLYPHS } from './glyphs.data'

// Glyph access in em units (1 em = the font size), y down, baseline at 0.

export type Glyph = {
  /** Advance width (for joined cursive text). */
  w: number
  /** Ink extent left to right. */
  x0: number
  x1: number
  /** Height above and depth below the baseline. */
  h: number
  d: number
  strokes: number[][]
}

/** Height of a lowercase letter, and of the math axis (where minus signs and fraction bars sit). */
export const X_HEIGHT = 0.35
export const AXIS = 0.24
export const CAP_HEIGHT = 0.66

const cache = new Map<string, Glyph | null>()

const ALIASES: Record<string, string> = {
  '’': "'",
  '‘': "'",
  '“': '"',
  '”': '"',
  '−': '-',
  '·': '⋅',
  ϵ: 'ε',
  ϕ: 'φ',
  ϑ: 'θ',
  '∥': '‖',
  ' ': ' ',
}

export function glyph(ch: string): Glyph | null {
  const key = ALIASES[ch] ?? ch
  if (cache.has(key)) return cache.get(key) ?? null
  const raw = GLYPHS[key]
  let g: Glyph | null = null
  if (raw) {
    const strokes = raw[1].map((s) => s.map((n) => n / 1000))
    let x0 = Number.POSITIVE_INFINITY
    let x1 = Number.NEGATIVE_INFINITY
    let y0 = 0
    let y1 = 0
    for (const s of strokes) {
      for (let i = 0; i < s.length; i += 2) {
        x0 = Math.min(x0, s[i] as number)
        x1 = Math.max(x1, s[i] as number)
        y0 = Math.min(y0, s[i + 1] as number)
        y1 = Math.max(y1, s[i + 1] as number)
      }
    }
    if (!strokes.length) {
      x0 = 0
      x1 = raw[0] / 1000
    }
    g = { w: raw[0] / 1000, x0, x1, h: -y0, d: y1, strokes }
  }
  cache.set(key, g)
  return g
}

export const hasGlyph = (ch: string) => glyph(ch) !== null
