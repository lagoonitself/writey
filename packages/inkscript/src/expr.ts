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
  pow: (a, b = 1) => a ** b,
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
    const base = atom()
    if (isOp('^')) {
      i++
      const exp = unary()
      return (v) => base(v) ** exp(v)
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
