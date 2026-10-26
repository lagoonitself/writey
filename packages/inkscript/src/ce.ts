// \ce{…}: chemical equations as LaTeX, like mhchem but small. "2H2 + O2 -> 2H2O",
// "Fe^3+ + 3OH- -> Fe(OH)3 v", "N2 + 3H2 <=>[Fe][450 °C] 2NH3", "CuSO4.5H2O".

const ARROWS: Record<string, string> = {
  '->': 'xrightarrow',
  '<-': 'xleftarrow',
  '<->': 'xleftrightarrow',
  '<=>': 'xrightleftharpoons',
  '<=>>': 'xrightleftharpoons',
  '<<=>': 'xrightleftharpoons',
  '=': 'xequals',
}

/** Splits on spaces, keeping [conditions] that contain spaces with their arrow. */
function tokens(src: string): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  for (const c of src) {
    if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth = Math.max(0, depth - 1)
    if (/\s/.test(c) && depth === 0) {
      if (cur) out.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur) out.push(cur)
  return out
}

/** A charge as LaTeX superscript content: "2+", "-", "3-", "δ+". */
const charge = (c: string) => c.replace(/^\{|\}$/g, '').replace(/-/g, '−')

/** One species: coefficient, formula with subscripts, charge and state. */
export function formulaToLatex(f: string): string {
  let s = f
  let out = ''
  // A leading coefficient: 2, 1/2, 3n.
  const coef = /^(\d+\/\d+|\d+(\.\d+)?)(?=[A-Z([])/.exec(s)
  if (coef) {
    out += `${coef[1]}\\,`
    s = s.slice(coef[0].length)
  }
  let i = 0
  let letters = ''
  const flush = () => {
    if (letters) out += `\\mathrm{${letters}}`
    letters = ''
  }
  while (i < s.length) {
    const c = s[i] as string
    const rest = s.slice(i)
    const state = /^\((s|l|g|aq)\)/.exec(rest)
    if (state) {
      flush()
      out += `\\,\\mathrm{(${state[1]})}`
      i += state[0].length
      continue
    }
    if (c === '^') {
      flush()
      const m = /^\^(\{[^}]*\}|[0-9]*[+\-−]|[0-9]+)/.exec(rest)
      const body = m ? (m[1] as string) : ''
      out += `^{${charge(body)}}`
      i += m ? m[0].length : 1
      continue
    }
    if (/[0-9]/.test(c) && i > 0) {
      flush()
      const m = /^[0-9]+/.exec(rest) as RegExpExecArray
      // Digits right after a formula are a subscript, or a charge when a sign follows (SO4 2-).
      out += `_{${m[0]}}`
      i += m[0].length
      continue
    }
    if ((c === '+' || c === '-') && i === s.length - 1 && i > 0) {
      flush()
      out += `^{${c === '-' ? '−' : '+'}}`
      i++
      continue
    }
    if (c === '.' || c === '*' || c === '·') {
      flush()
      out += '\\cdot '
      i++
      // A coefficient after the dot (CuSO4.5H2O) is not a subscript.
      const m = /^[0-9]+/.exec(s.slice(i))
      if (m) {
        out += m[0]
        i += m[0].length
      }
      continue
    }
    if (c === '(' || c === ')' || c === '[' || c === ']') {
      flush()
      out += c
      i++
      continue
    }
    if (c === '\\') {
      flush()
      const m = /^\\[a-zA-Z]+/.exec(rest)
      out += m ? `${m[0]} ` : '\\backslash '
      i += m ? m[0].length : 1
      continue
    }
    letters += c
    i++
  }
  flush()
  return out
}

/** A whole \ce{…} body as LaTeX. */
export function ceToLatex(src: string): string {
  const out: string[] = []
  for (const t of tokens(src.trim())) {
    const arrow = /^(<=>>|<<=>|<=>|<->|->|<-|=)(?:\[([^\]]*)\])?(?:\[([^\]]*)\])?$/.exec(t)
    if (arrow) {
      const cmd = ARROWS[arrow[1] as string] as string
      const above = arrow[2] ? words(arrow[2]) : ''
      const below = arrow[3] ? words(arrow[3]) : ''
      out.push(`\\${cmd}${below ? `[${below}]` : ''}{${above}}`)
    } else if (t === '+') out.push('+')
    else if (t === 'v') out.push('\\downarrow')
    else if (t === '^') out.push('\\uparrow')
    else out.push(formulaToLatex(t))
  }
  return out.join(' ')
}

/** Conditions over an arrow: formulas stay formulas, words stay words. */
function words(s: string): string {
  return tokens(s)
    .map((w) => (/[A-Z][a-z]?\d|^[A-Z][a-z]?$|\^/.test(w) ? formulaToLatex(w) : `\\mathrm{${w}}`))
    .join('\\ ')
}
