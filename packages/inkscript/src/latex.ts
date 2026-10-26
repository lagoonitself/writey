import { ceToLatex } from './ce'
// A small LaTeX math parser covering what school and university math and physics use.
// Unknown commands degrade to their name as text instead of failing (docs §5.5).

/** TeX atom classes, used for spacing. */
export type AtomClass = 'ord' | 'op' | 'bin' | 'rel' | 'open' | 'close' | 'punct'

export type Delim =
  | '('
  | ')'
  | '['
  | ']'
  | '{'
  | '}'
  | '|'
  | '‖'
  | '⟨'
  | '⟩'
  | '⌊'
  | '⌋'
  | '⌈'
  | '⌉'
  | '.'

export type AccentKind = 'vec' | 'hat' | 'bar' | 'dot' | 'ddot' | 'tilde' | 'underline'

export type MathNode =
  | { t: 'sym'; ch: string; cls: AtomClass; upright?: boolean }
  | { t: 'delim'; d: Delim; cls: 'open' | 'close' | 'ord'; size: number }
  | { t: 'group'; body: MathNode[] }
  | { t: 'scripts'; base: MathNode | null; sup?: MathNode; sub?: MathNode }
  | { t: 'frac'; num: MathNode; den: MathNode; bar: boolean }
  | { t: 'sqrt'; body: MathNode; index?: MathNode }
  /** Big operators (∑, ∫) and named ones (lim, sin). `limits`: scripts above and below. */
  | { t: 'op'; ch?: string; name?: string; limits: boolean }
  | { t: 'text'; text: string }
  | { t: 'accent'; kind: AccentKind; body: MathNode }
  | { t: 'leftright'; left: Delim; right: Delim; body: MathNode[] }
  | { t: 'space'; em: number }
  | { t: 'array'; rows: MathNode[][]; align: ('l' | 'c' | 'r')[]; left: Delim; right: Delim }
  | { t: 'boxed'; body: MathNode }
  | { t: 'cancel'; body: MathNode }
  /** A reaction arrow that stretches to fit the conditions written over and under it. */
  | { t: 'xarrow'; kind: XArrow; above?: MathNode; below?: MathNode }

export type XArrow = '->' | '<-' | '<->' | '<=>' | '='

const XARROWS: Record<string, XArrow> = {
  xrightarrow: '->',
  xleftarrow: '<-',
  xleftrightarrow: '<->',
  xrightleftharpoons: '<=>',
  xequals: '=',
}

const GREEK: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'θ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  omicron: 'ο',
  pi: 'π',
  varpi: 'π',
  rho: 'ρ',
  varrho: 'ρ',
  sigma: 'σ',
  varsigma: 'σ',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  varphi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
}

const SYMBOLS: Record<string, [string, AtomClass]> = {
  pm: ['±', 'bin'],
  mp: ['∓', 'bin'],
  times: ['×', 'bin'],
  cdot: ['⋅', 'bin'],
  div: ['÷', 'bin'],
  ast: ['*', 'bin'],
  circ: ['∘', 'bin'],
  cup: ['∪', 'bin'],
  cap: ['∩', 'bin'],
  setminus: ['\\', 'bin'],
  le: ['≤', 'rel'],
  leq: ['≤', 'rel'],
  leqslant: ['≤', 'rel'],
  ge: ['≥', 'rel'],
  geq: ['≥', 'rel'],
  geqslant: ['≥', 'rel'],
  ne: ['≠', 'rel'],
  neq: ['≠', 'rel'],
  approx: ['≈', 'rel'],
  equiv: ['≡', 'rel'],
  sim: ['∼', 'rel'],
  simeq: ['≅', 'rel'],
  cong: ['≅', 'rel'],
  propto: ['∝', 'rel'],
  to: ['→', 'rel'],
  rightarrow: ['→', 'rel'],
  longrightarrow: ['→', 'rel'],
  mapsto: ['→', 'rel'],
  leftarrow: ['←', 'rel'],
  gets: ['←', 'rel'],
  uparrow: ['↑', 'rel'],
  downarrow: ['↓', 'rel'],
  leftrightarrow: ['↔', 'rel'],
  rightleftharpoons: ['⇌', 'rel'],
  leftrightarrows: ['⇄', 'rel'],
  rightleftarrows: ['⇄', 'rel'],
  Rightarrow: ['⇒', 'rel'],
  implies: ['⇒', 'rel'],
  Longrightarrow: ['⇒', 'rel'],
  Leftarrow: ['⇐', 'rel'],
  impliedby: ['⇐', 'rel'],
  Leftrightarrow: ['⇔', 'rel'],
  iff: ['⇔', 'rel'],
  Longleftrightarrow: ['⇔', 'rel'],
  in: ['∈', 'rel'],
  notin: ['∉', 'rel'],
  subset: ['⊂', 'rel'],
  subseteq: ['⊆', 'rel'],
  supset: ['⊃', 'rel'],
  supseteq: ['⊇', 'rel'],
  perp: ['⊥', 'rel'],
  parallel: ['‖', 'rel'],
  mid: ['|', 'rel'],
  infty: ['∞', 'ord'],
  partial: ['∂', 'ord'],
  nabla: ['∇', 'ord'],
  hbar: ['ℏ', 'ord'],
  ell: ['l', 'ord'],
  forall: ['∀', 'ord'],
  exists: ['∃', 'ord'],
  emptyset: ['∅', 'ord'],
  varnothing: ['∅', 'ord'],
  angle: ['∠', 'ord'],
  degree: ['°', 'ord'],
  prime: ['′', 'ord'],
  ldots: ['…', 'ord'],
  dots: ['…', 'ord'],
  cdots: ['⋯', 'ord'],
  therefore: ['∴', 'rel'],
  '%': ['%', 'ord'],
  $: ['$', 'ord'],
  '#': ['#', 'ord'],
  '&': ['&', 'ord'],
  _: ['_', 'ord'],
}

/** Operators drawn as a big symbol. */
const BIG_OPS: Record<string, [string, boolean]> = {
  sum: ['∑', true],
  prod: ['∏', true],
  bigcup: ['∪', true],
  bigcap: ['∩', true],
  int: ['∫', false],
  oint: ['∮', false],
  iint: ['∬', false],
}

/** Operators written as a word. `true`: scripts go above and below (lim x→0). */
const NAMED_OPS: Record<string, boolean> = {
  lim: true,
  max: true,
  min: true,
  sup: true,
  inf: true,
  det: true,
  gcd: true,
  sin: false,
  cos: false,
  tan: false,
  sec: false,
  csc: false,
  cot: false,
  arcsin: false,
  arccos: false,
  arctan: false,
  sinh: false,
  cosh: false,
  tanh: false,
  ln: false,
  log: false,
  exp: false,
  arg: false,
  deg: false,
  dim: false,
  ker: false,
  Pr: false,
  Re: false,
  Im: false,
}

const DELIMS: Record<string, Delim> = {
  '(': '(',
  ')': ')',
  '[': '[',
  ']': ']',
  '\\{': '{',
  '\\}': '}',
  '\\lbrace': '{',
  '\\rbrace': '}',
  '|': '|',
  '\\|': '‖',
  '\\vert': '|',
  '\\lvert': '|',
  '\\rvert': '|',
  '\\Vert': '‖',
  '\\lVert': '‖',
  '\\rVert': '‖',
  '\\langle': '⟨',
  '\\rangle': '⟩',
  '\\lfloor': '⌊',
  '\\rfloor': '⌋',
  '\\lceil': '⌈',
  '\\rceil': '⌉',
  '.': '.',
}

const OPENERS = new Set<Delim>(['(', '[', '{', '⟨', '⌊', '⌈'])

const ACCENTS: Record<string, AccentKind> = {
  vec: 'vec',
  overrightarrow: 'vec',
  hat: 'hat',
  widehat: 'hat',
  bar: 'bar',
  overline: 'bar',
  dot: 'dot',
  ddot: 'ddot',
  tilde: 'tilde',
  widetilde: 'tilde',
  underline: 'underline',
}

const SPACES: Record<string, number> = {
  ',': 0.167,
  ':': 0.222,
  '>': 0.222,
  ';': 0.278,
  '!': -0.12,
  ' ': 0.3,
  quad: 1,
  qquad: 2,
  enspace: 0.5,
  thinspace: 0.167,
}

const BIG_SIZES: Record<string, number> = {
  big: 1.2,
  bigl: 1.2,
  bigr: 1.2,
  Big: 1.6,
  Bigl: 1.6,
  Bigr: 1.6,
  bigg: 2.1,
  biggl: 2.1,
  biggr: 2.1,
  Bigg: 2.6,
  Biggl: 2.6,
  Biggr: 2.6,
}

/** Commands whose argument is just rendered (fonts we draw the same way). */
const PASS_THROUGH = new Set([
  'mathbf',
  'mathit',
  'mathcal',
  'mathbb',
  'mathsf',
  'mathscr',
  'mathfrak',
  'boldsymbol',
  'bm',
  'pmb',
  'displaystyle',
  'textstyle',
  'scriptstyle',
  'limits',
  'nolimits',
])
const TEXT_CMDS = new Set([
  'text',
  'textrm',
  'textit',
  'textbf',
  'mathrm',
  'operatorname',
  'mbox',
  'textnormal',
  'rm',
])

type Tok = { k: 'cmd'; v: string } | { k: 'ch'; v: string }

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i] as string
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(src.slice(i))
      if (!m) break
      toks.push({ k: 'cmd', v: m[1] as string })
      i += m[0].length
    } else if (c === '%' && src[i - 1] !== '\\') {
      // A comment runs to the end of the line.
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl + 1
    } else {
      toks.push({ k: 'ch', v: c })
      i++
    }
  }
  return toks
}

const CLASS_OF: Record<string, AtomClass> = {
  '+': 'bin',
  '-': 'bin',
  '*': 'bin',
  '/': 'ord',
  '=': 'rel',
  '<': 'rel',
  '>': 'rel',
  ':': 'rel',
  ',': 'punct',
  ';': 'punct',
  '!': 'ord',
  '?': 'ord',
}

class Parser {
  private i = 0
  constructor(private readonly toks: Tok[]) {}

  peek(): Tok | undefined {
    return this.toks[this.i]
  }

  private next(): Tok | undefined {
    return this.toks[this.i++]
  }

  private skipSpace(): void {
    while (this.peek()?.k === 'ch' && /\s/.test(this.peek()?.v as string)) this.i++
  }

  /** Parses until `}` (consumed by the caller), `\right`, `\end`, `&`, `\\` or the end. */
  list(stopAtCells = false): MathNode[] {
    const out: MathNode[] = []
    while (true) {
      this.skipSpace()
      const t = this.peek()
      if (!t) break
      if (t.k === 'ch' && t.v === '}') break
      if (t.k === 'cmd' && (t.v === 'right' || t.v === 'end')) break
      if (stopAtCells && ((t.k === 'ch' && t.v === '&') || (t.k === 'cmd' && t.v === '\\'))) break
      if (t.k === 'ch' && (t.v === '^' || t.v === '_' || t.v === "'")) {
        this.scripts(out)
        continue
      }
      const atom = this.atom()
      if (atom) out.push(atom)
    }
    return out
  }

  private scripts(out: MathNode[]): void {
    const prev = out.at(-1)
    let node: Extract<MathNode, { t: 'scripts' }>
    if (prev?.t === 'scripts') node = prev
    else {
      node = { t: 'scripts', base: prev ?? null }
      if (prev) out.pop()
      out.push(node)
    }
    const t = this.next() as Tok
    if (t.v === "'") {
      // Primes: f' and f''.
      let primes = '′'
      while (this.peek()?.k === 'ch' && this.peek()?.v === "'") {
        this.i++
        primes += '′'
      }
      const p: MathNode = { t: 'group', body: [...primes].map((ch) => sym(ch, 'ord')) }
      node.sup = node.sup ? { t: 'group', body: [p, node.sup] } : p
      return
    }
    const arg = this.arg()
    if (t.v === '^') node.sup = node.sup ? { t: 'group', body: [node.sup, arg] } : arg
    else node.sub = node.sub ? { t: 'group', body: [node.sub, arg] } : arg
  }

  /** One argument: a braced group or a single token. */
  arg(): MathNode {
    this.skipSpace()
    const t = this.peek()
    if (!t) return { t: 'group', body: [] }
    if (t.k === 'ch' && t.v === '{') {
      this.i++
      const body = this.list()
      if (this.peek()?.v === '}') this.i++
      return body.length === 1 ? (body[0] as MathNode) : { t: 'group', body }
    }
    return this.atom() ?? { t: 'group', body: [] }
  }

  /** Raw text of a braced argument, for \text{…} and \begin{…}. */
  private rawArg(): string {
    this.skipSpace()
    if (this.peek()?.v !== '{') return this.next()?.v ?? ''
    this.i++
    let depth = 1
    let s = ''
    while (this.peek()) {
      const t = this.next() as Tok
      if (t.k === 'ch' && t.v === '{') depth++
      if (t.k === 'ch' && t.v === '}' && --depth === 0) break
      s += t.k === 'cmd' ? (/^[a-zA-Z]/.test(t.v) ? `\\${t.v} ` : t.v) : t.v
    }
    return s
  }

  private optArg(): string | null {
    this.skipSpace()
    if (this.peek()?.v !== '[') return null
    this.i++
    let s = ''
    while (this.peek() && this.peek()?.v !== ']') {
      const t = this.next() as Tok
      s += t.k === 'cmd' ? `\\${t.v} ` : t.v
    }
    this.i++
    return s
  }

  private delim(): Delim {
    this.skipSpace()
    const t = this.next()
    if (!t) return '.'
    const key = t.k === 'cmd' ? `\\${t.v}` : t.v
    return DELIMS[key] ?? '.'
  }

  atom(): MathNode | null {
    const t = this.next()
    if (!t) return null
    if (t.k === 'ch') {
      const c = t.v
      if (c === '{') {
        const body = this.list()
        if (this.peek()?.v === '}') this.i++
        return { t: 'group', body }
      }
      if (c === '}' || c === '&') return null
      if (c === '~') return { t: 'space', em: 0.3 }
      if (DELIMS[c] && c !== '.') {
        const d = DELIMS[c] as Delim
        return {
          t: 'delim',
          d,
          cls: d === '|' ? 'ord' : OPENERS.has(d) ? 'open' : 'close',
          size: 0,
        }
      }
      return sym(c, CLASS_OF[c] ?? 'ord')
    }
    const name = t.v
    if (GREEK[name]) return sym(GREEK[name] as string, 'ord')
    if (SYMBOLS[name]) {
      const [ch, cls] = SYMBOLS[name] as [string, AtomClass]
      return sym(ch, cls)
    }
    if (BIG_OPS[name]) {
      const [ch, limits] = BIG_OPS[name] as [string, boolean]
      return { t: 'op', ch, limits }
    }
    if (name in NAMED_OPS) return { t: 'op', name, limits: NAMED_OPS[name] as boolean }
    if (name in SPACES) return { t: 'space', em: SPACES[name] as number }
    if (DELIMS[`\\${name}`]) {
      const d = DELIMS[`\\${name}`] as Delim
      return {
        t: 'delim',
        d,
        cls: d === '|' || d === '‖' ? 'ord' : OPENERS.has(d) ? 'open' : 'close',
        size: 0,
      }
    }
    switch (name) {
      case 'frac':
      case 'dfrac':
      case 'tfrac':
      case 'cfrac':
        return { t: 'frac', num: this.arg(), den: this.arg(), bar: true }
      case 'binom':
      case 'dbinom':
        return {
          t: 'leftright',
          left: '(',
          right: ')',
          body: [{ t: 'frac', num: this.arg(), den: this.arg(), bar: false }],
        }
      case 'sqrt': {
        const index = this.optArg()
        const body = this.arg()
        return index ? { t: 'sqrt', body, index: parseMath(index) } : { t: 'sqrt', body }
      }
      case 'left': {
        const left = this.delim()
        const body = this.list()
        let right: Delim = '.'
        if (this.peek()?.k === 'cmd' && this.peek()?.v === 'right') {
          this.i++
          right = this.delim()
        }
        return { t: 'leftright', left, right, body }
      }
      case 'right':
        return null
      case 'boxed':
        return { t: 'boxed', body: this.arg() }
      case 'ce':
        return parseMath(ceToLatex(this.rawArg()))
      case 'cancel':
      case 'bcancel':
      case 'xcancel':
        return { t: 'cancel', body: this.arg() }
      case 'begin':
        return this.environment(this.rawArg().trim())
      case 'end':
        this.rawArg()
        return null
      case '\\':
        return null
      case 'not': {
        const next = this.atom()
        if (next?.t === 'sym' && next.ch === '=') return sym('≠', 'rel')
        if (next?.t === 'sym' && next.ch === '∈') return sym('∉', 'rel')
        return next
      }
      case 'mathrm':
      case 'operatorname': {
        const raw = this.rawArg()
        // \mathrm{d}x and \operatorname{sgn}: upright words, drawn as text.
        return { t: 'text', text: raw.replace(/\\,|\\ /g, ' ').replace(/\\([a-zA-Z]+)\s?/g, '$1') }
      }
    }
    if (XARROWS[name]) {
      const below = this.optArg()
      const above = this.rawArg()
      return {
        t: 'xarrow',
        kind: XARROWS[name] as XArrow,
        above: above.trim() ? parseMath(above) : undefined,
        below: below?.trim() ? parseMath(below) : undefined,
      }
    }
    if (TEXT_CMDS.has(name)) return { t: 'text', text: this.rawArg() }
    if (ACCENTS[name]) return { t: 'accent', kind: ACCENTS[name] as AccentKind, body: this.arg() }
    if (BIG_SIZES[name]) {
      const d = this.delim()
      return {
        t: 'delim',
        d,
        cls: OPENERS.has(d) ? 'open' : 'close',
        size: BIG_SIZES[name] as number,
      }
    }
    if (PASS_THROUGH.has(name)) {
      // Style switches take no argument; font commands take one.
      if (/style$|limits$/.test(name)) return null
      return this.arg()
    }
    // Unknown command: write its name rather than dropping it.
    return { t: 'text', text: name }
  }

  private environment(env: string): MathNode {
    const name = env.replace(/\*$/, '')
    if (name === 'array') this.rawArg()
    const rows: MathNode[][] = []
    let row: MathNode[] = []
    while (this.peek()) {
      const cell = this.list(true)
      row.push(cell.length === 1 ? (cell[0] as MathNode) : { t: 'group', body: cell })
      const t = this.next()
      if (!t) break
      if (t.k === 'ch' && t.v === '&') continue
      if (t.k === 'cmd' && t.v === '\\') {
        rows.push(row)
        row = []
        continue
      }
      if (t.k === 'cmd' && t.v === 'end') {
        this.rawArg()
        break
      }
      if (t.k === 'ch' && t.v === '}') break
    }
    if (row.length && !(row.length === 1 && isEmpty(row[0] as MathNode))) rows.push(row)
    const cols = Math.max(1, ...rows.map((r) => r.length))
    const wrap: Record<string, [Delim, Delim]> = {
      pmatrix: ['(', ')'],
      bmatrix: ['[', ']'],
      Bmatrix: ['{', '}'],
      vmatrix: ['|', '|'],
      Vmatrix: ['‖', '‖'],
      cases: ['{', '.'],
    }
    const [left, right] = wrap[name] ?? ['.', '.']
    const aligned = /^(aligned|align|split|alignat|eqnarray)$/.test(name)
    const align: ('l' | 'c' | 'r')[] = Array.from({ length: cols }, (_, i) =>
      aligned ? (i % 2 === 0 ? 'r' : 'l') : name === 'cases' ? 'l' : 'c',
    )
    return { t: 'array', rows, align, left, right }
  }
}

const isEmpty = (n: MathNode) => n.t === 'group' && n.body.length === 0

function sym(ch: string, cls: AtomClass): MathNode {
  return { t: 'sym', ch, cls }
}

export function parseMath(src: string): MathNode {
  const p = new Parser(tokenize(src))
  const body: MathNode[] = []
  // Stray closing braces or \right never stop the whole formula.
  for (let guard = 0; guard < 1000; guard++) {
    body.push(...p.list())
    if (!p.atom() && !p.peek()) break
  }
  return { t: 'group', body }
}

/**
 * Splits a formula at top-level `\\` (outside environments and braces) into rows, and
 * drops the `$`, `$$`, `\[ \]` or `\( \)` the model may have wrapped it in.
 */
export function splitRows(src: string): string[] {
  let s = src.trim()
  s = s.replace(/^\$\$([\s\S]*)\$\$$/, '$1').replace(/^\$([\s\S]*)\$$/, '$1')
  s = s.replace(/^\\\[([\s\S]*)\\\]$/, '$1').replace(/^\\\(([\s\S]*)\\\)$/, '$1')
  const rows: string[] = []
  let depth = 0
  let env = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      if (s.startsWith('\\begin', i)) env++
      else if (s.startsWith('\\end', i)) env--
      else if (s[i + 1] === '\\' && depth === 0 && env === 0) {
        rows.push(s.slice(start, i))
        start = i + 2
      }
      i++
      continue
    }
    if (c === '{') depth++
    else if (c === '}') depth--
  }
  rows.push(s.slice(start))
  return rows.map((r) => r.trim()).filter(Boolean)
}
