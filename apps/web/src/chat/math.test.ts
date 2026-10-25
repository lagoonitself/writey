import { describe, expect, it } from 'vitest'
import { extractMath } from './math'

describe('extractMath', () => {
  it('pulls out inline and display math in all four styles', () => {
    const { text, math } = extractMath('Let $x_1$ and \\(y^2\\).\n$$\\int_0^1 x\\,dx$$\n\\[a_b\\]')
    expect(text).toBe('Let KTXMATH0END and KTXMATH1END.\nKTXMATH2END\nKTXMATH3END')
    expect(math).toEqual([
      { tex: 'x_1', display: false },
      { tex: 'y^2', display: false },
      { tex: '\\int_0^1 x\\,dx', display: true },
      { tex: 'a_b', display: true },
    ])
  })

  it('leaves money, escaped dollars and code alone', () => {
    const src = 'It costs $5 and $10. Not \\$x\\$. Code: `$a$` and\n```\n$$b$$\n```'
    const { text, math } = extractMath(src)
    expect(math).toEqual([])
    expect(text).toBe(src)
  })

  it('keeps an unclosed delimiter as text while streaming', () => {
    expect(extractMath('So $$\\frac{1}{2').math).toEqual([])
  })
})
