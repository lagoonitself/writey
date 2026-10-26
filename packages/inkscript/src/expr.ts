// A small, safe math expression compiler for plots: "2x^2 - sin(x)/x", "e^(-t) cos(3t)".
// No eval. Supports + - * / ^ (or **), unary minus, implicit multiplication, pi, e and the
// usual functions. Unknown names compile to NaN instead of throwing.

export type Fn = (vars: Record<string, number>) => number

const FUNCS: Record<string, (a: number, b?: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sec: (a) => 1 / Math.cos(a),
  csc: (a) => 1 / Math.sin(a),
  cot: (a) => 1 / Math.tan(a),
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  arcsin: Math.asin,
  arccos: Math.acos,
  arctan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log2: Math.log2,
  log10: Math.log10,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  min: (a, b = a) => Math.min(a, b),
  max: (a, b = a) => Math.max(a, b),
  pow: (a, b = 1) => pow(a, b),
  gamma: (a) => gamma(a),
  fact: (a) => factorial(a),
  factorial: (a) => factorial(a),
  nroot: (a, b = 2) => pow(a, 1 / b),
  root: (a, b = 2) => pow(a, 1 / b),
  mod: (a, b = 1) => ((a % b) + b) % b,
}

/** Powers as a student means them: (−8)^(1/3) is −2, not NaN. */
function pow(a: number, b: number): number {
  if (a >= 0 || Number.isInteger(b)) return a ** b
  // A fraction with an odd denominator has a real root of a negative number.
  for (let q = 3; q <= 15; q += 2) {
    const p = Math.round(b * q)
    if (Math.abs(b * q - p) < 1e-9) return (p % 2 ? -1 : 1) * (-a) ** b
  }
  return Number.NaN
}

/** Lanczos approximation, so x! plots between the integers too. */
function gamma(z: number): number {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z))
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  const x = z - 1
  let a = c[0] as number
  const t = x + g + 0.5
  for (let k = 1; k < g + 2; k++) a += (c[k] as number) / (x + k)
  return Math.sqrt(2 * Math.PI) * t ** (x + 0.5) * Math.exp(-t) * a
}

function factorial(n: number): number {
  if (Number.isInteger(n) && n >= 0 && n <= 170) {
    let r = 1
    for (let k = 2; k <= n; k++) r *= k
    return r
  }
  return gamma(n + 1)
}

const CONSTS: Record<string, number> = { pi: Math.PI, π: Math.PI, e: Math.E, tau: Math.PI * 2 }

type Tok = { k: 'num'; v: number } | { k: 'id'; v: string } | { k: 'op'; v: string }

function tokenize(src: string): Tok[] {
  const s = src
    .replace(/Math\./g, '')
    .replace(/\*\*/g, '^')
    .replace(/[·×]/g, '*')
    .replace(/[−–]/g, '-')
    .replace(/\\(left|right)/g, '')
    .replace(/\\/g, '')
  const out: Tok[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i] as string
    if (/\s/.test(c)) i++
    else if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i)) as RegExpExecArray
      out.push({ k: 'num', v: Number(m[0]) })
      i += m[0].length
    } else if (/[a-zA-Zπ_]/.test(c)) {
      const m = /^[a-zA-Zπ_][a-zA-Z0-9_]*/.exec(s.slice(i)) as RegExpExecArray
      out.push({ k: 'id', v: m[0] })
      i += m[0].length
    } else {
      out.push({ k: 'op', v: c === '[' || c === '{' ? '(' : c === ']' || c === '}' ? ')' : c })
      i++
    }
  }
  return out
}

/** Splits a run of letters like "xsin" or "pix" into known names, so "2pix" reads as 2·π·x. */
function splitName(name: string, vars: readonly string[]): string[] | null {
  if (name in FUNCS || name in CONSTS || vars.includes(name)) return [name]
  for (let n = Math.min(6, name.length - 1); n >= 1; n--) {
    const head = name.slice(0, n)
    if (head in FUNCS || head in CONSTS || vars.includes(head)) {
      const rest = splitName(name.slice(n), vars)
      if (rest) return [head, ...rest]
    }
  }
  return null
}

export function compile(src: string, vars: readonly string[] = ['x']): Fn {
  const toks: Tok[] = []
  for (const t of tokenize(src)) {
    if (t.k === 'id') for (const v of splitName(t.v, vars) ?? [t.v]) toks.push({ k: 'id', v })
    else toks.push(t)
  }
  let i = 0
  /** Inside |…|, a bar closes instead of opening another. */
  let bars = 0
  const peek = () => toks[i]
  const isOp = (v: string) => peek()?.k === 'op' && peek()?.v === v
  const startsFactor = () => {
    const t = peek()
    return !!t && (t.k !== 'op' || t.v === '(' || (t.v === '|' && !bars))
  }

  const expr = (): Fn => {
    let left = term()
    while (isOp('+') || isOp('-')) {
      const op = (toks[i++] as Tok).v
      const a = left
      const b = term()
      left = op === '+' ? (v) => a(v) + b(v) : (v) => a(v) - b(v)
    }
    return left
  }
  const term = (): Fn => {
    let left = unary()
    for (;;) {
      if (isOp('*') || isOp('/')) {
        const op = (toks[i++] as Tok).v
        const a = left
        const b = unary()
        left = op === '*' ? (v) => a(v) * b(v) : (v) => a(v) / b(v)
      } else if (startsFactor()) {
        const a = left
        const b = power()
        left = (v) => a(v) * b(v)
      } else return left
    }
  }
  const unary = (): Fn => {
    if (isOp('-')) {
      i++
      const a = unary()
      return (v) => -a(v)
    }
    if (isOp('+')) i++
    return power()
  }
  const power = (): Fn => {
    let base = atom()
    while (isOp('!')) {
      i++
      const a = base
      base = (v) => factorial(a(v))
    }
    if (isOp('^')) {
      i++
      const exp = unary()
      return (v) => pow(base(v), exp(v))
    }
    return base
  }
  const atom = (): Fn => {
    const t = toks[i++]
    if (!t) return () => Number.NaN
    if (t.k === 'num') return () => t.v
    if (t.k === 'op' && t.v === '(') {
      const inner = expr()
      if (isOp(')')) i++
      return inner
    }
    if (t.k === 'op' && t.v === '|') {
      bars++
      const inner = expr()
      bars--
      if (isOp('|')) i++
      return (v) => Math.abs(inner(v))
    }
    if (t.k === 'id') {
      const name = t.v
      if (vars.includes(name)) return (v) => v[name] ?? Number.NaN
      if (name in CONSTS) {
        const c = CONSTS[name] as number
        return () => c
      }
      const f = FUNCS[name]
      if (f) {
        // sin^2(x)
        let exp: Fn | null = null
        if (isOp('^')) {
          i++
          exp = atom()
        }
        let args: Fn[]
        if (isOp('(')) {
          i++
          args = [expr()]
          while (isOp(',')) {
            i++
            args.push(expr())
          }
          if (isOp(')')) i++
        } else args = [power()]
        const [a, b] = args as [Fn, Fn | undefined]
        const call: Fn = b ? (v) => f(a(v), b(v)) : (v) => f(a(v))
        return exp ? (v) => call(v) ** (exp as Fn)(v) : call
      }
    }
    return () => Number.NaN
  }

  try {
    const fn = expr()
    return (v) => {
      try {
        return fn(v)
      } catch {
        return Number.NaN
      }
    }
  } catch {
    return () => Number.NaN
  }
}

export type Relation = { f: Fn; op: '<' | '<=' | '>' | '>=' | '=' }

/**
 * Reads "y < 2x + 1", "x^2 + y^2 = 4" or "0 <= x <= 2" as relations f op 0 (f = left − right).
 * A chain gives one relation per comparison.
 */
export function relations(src: string, vars: readonly string[] = ['x', 'y']): Relation[] {
  const s = src
    .replace(/≤|\\le(q)?\b/g, '<=')
    .replace(/≥|\\ge(q)?\b/g, '>=')
    .replace(/==/g, '=')
  const parts: string[] = []
  const ops: Relation['op'][] = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    if (depth === 0 && (c === '<' || c === '>' || c === '=')) {
      const two = s[i + 1] === '='
      ops.push((c === '=' ? '=' : two ? `${c}=` : c) as Relation['op'])
      parts.push(cur)
      cur = ''
      if (two && c !== '=') i++
      continue
    }
    cur += c
  }
  parts.push(cur)
  if (!ops.length) return [{ f: compile(src, vars), op: '=' }]
  const fs = parts.map((p) => compile(p, vars))
  return ops.map((op, k) => {
    const a = fs[k] as Fn
    const b = fs[k + 1] as Fn
    return { f: (v) => a(v) - b(v), op }
  })
}

/** Whether a point satisfies every relation (an equation counts within `tol`). */
export function holds(rs: readonly Relation[], v: Record<string, number>, tol = 1e-9): boolean {
  for (const r of rs) {
    const d = r.f(v)
    if (!Number.isFinite(d)) return false
    if (r.op === '<' && !(d < 0)) return false
    if (r.op === '<=' && !(d <= tol)) return false
    if (r.op === '>' && !(d > 0)) return false
    if (r.op === '>=' && !(d >= -tol)) return false
    if (r.op === '=' && Math.abs(d) > tol) return false
  }
  return true
}
