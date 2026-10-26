import { type DiagramSpec, diagramItems } from './diagram'
import type { TableSpec } from './table'

// InkScript: the AI's drawing language (docs §5.4). The model streams one JSON object
// per block; each block is drawn as soon as it arrives.

export type MarkKind =
  | 'circle'
  | 'underline'
  | 'cross'
  | 'tick'
  | 'arrow'
  | 'highlight'
  | 'box'
  | 'point'

/**
 * A spot the model points at, in pixels of an image it was shown (like a computer-use
 * click): image 1 is the focus region, image 2 the whole page. Writey maps it to the page.
 */
export type Pin = { img: 1 | 2; at?: [number, number]; box?: [number, number, number, number] }

export type InkBlock =
  | { type: 'status'; text: string }
  /** Words, with inline $math$. `after`: a line tag ("L3") or "prev". */
  | { type: 'text'; text: string; after?: string; why?: string; pin?: Pin; size?: number }
  | {
      type: 'math'
      latex: string
      after?: string
      box?: boolean
      why?: string
      pin?: Pin
      size?: number
    }
  /** Red pen on a line (`target`) or on any spot (`pin`). */
  | { type: 'mark'; kind: MarkKind; target?: string; pin?: Pin; note?: string }
  /** A hand-drawn diagram or graph (docs §5.6). */
  | ({ type: 'diagram'; after?: string; title?: string; why?: string } & DiagramSpec)
  /** A ruled table (truth tables, observations, comparisons); cells may hold $math$. */
  | ({ type: 'table'; after?: string; title?: string; why?: string } & TableSpec)
  /** Start a fresh page and carry on at its top. */
  | { type: 'page' }
  /** Markdown for the chat panel: explanations that don't belong on the page. */
  | { type: 'chat'; text: string }
  /** Plain words Writey says out loud (spoken replies), math read as words. */
  | { type: 'say'; text: string }
  | { type: 'done'; summary?: string }

const MARKS: readonly string[] = [
  'circle',
  'underline',
  'cross',
  'tick',
  'arrow',
  'highlight',
  'box',
  'point',
]

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Reads `at: [x, y]` and/or `box: [x0, y0, x1, y1]` (pixels) and `img`. */
function pin(o: Record<string, unknown>): Pin | undefined {
  const nums = (v: unknown, n: number) =>
    Array.isArray(v) && v.length === n && v.every((x) => num(x) !== null) ? (v as number[]) : null
  const at = nums(o.at ?? o.point, 2)
  const b = nums(o.box ?? o.bbox ?? o.region, 4)
  if (!at && !b) return undefined
  const box = b
    ? ([
        Math.min(b[0] as number, b[2] as number),
        Math.min(b[1] as number, b[3] as number),
        Math.max(b[0] as number, b[2] as number),
        Math.max(b[1] as number, b[3] as number),
      ] as [number, number, number, number])
    : undefined
  return {
    img: o.img === 2 || o.image === 2 || o.img === 'page' ? 2 : 1,
    at: at ? [at[0] as number, at[1] as number] : undefined,
    box,
  }
}

const size = (v: unknown) => {
  const n = num(v)
  return n !== null && n > 0 ? n : undefined
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

const after = (v: unknown): string | undefined => {
  const s = str(v)
  if (/^l\d+$/i.test(s)) return s.toUpperCase()
  if (/^(prev|previous|last)$/i.test(s)) return 'prev'
  return undefined
}

/** Checks one parsed object and fills in what can be inferred. Returns null if unusable. */
export function toBlock(raw: unknown): InkBlock | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const why = str(o.why) || undefined
  switch (str(o.type)) {
    case 'status':
      return str(o.text) ? { type: 'status', text: str(o.text) } : null
    case 'text':
    case 'write':
      return str(o.text)
        ? {
            type: 'text',
            text: str(o.text),
            after: after(o.after),
            why,
            pin: pin(o),
            size: size(o.size),
          }
        : null
    case 'math':
    case 'equation': {
      const latex = str(o.latex) || str(o.text)
      return latex
        ? {
            type: 'math',
            latex,
            after: after(o.after),
            box: o.box === true,
            why,
            pin: pin({ ...o, box: undefined }),
            size: size(o.size),
          }
        : null
    }
    case 'mark': {
      const kind = str(o.kind).toLowerCase()
      const target = str(o.target).toUpperCase()
      const at = pin(o)
      if (!/^L\d+$/.test(target) && !at) return null
      return {
        type: 'mark',
        kind: (MARKS.includes(kind) ? kind : 'circle') as MarkKind,
        target: /^L\d+$/.test(target) ? target : undefined,
        pin: at,
        note: str(o.note) || str(o.text) || undefined,
      }
    }
    case 'diagram':
    case 'graph':
    case 'plot':
    case 'sketch':
    case 'figure': {
      // The docs' nested form: {"type":"diagram","spec":{"frame":{…},"items":[…]}}.
      const spec = (o.spec && typeof o.spec === 'object' ? o.spec : o) as Record<string, unknown>
      const frame = (spec.frame && typeof spec.frame === 'object' ? spec.frame : spec) as Record<
        string,
        unknown
      >
      let items = diagramItems(spec.items ?? spec.shapes ?? o.items)
      // A bare {"type":"plot","expr":"sin(x)"} is a one-curve graph.
      if (!items.length && (o.expr || o.fn)) items = diagramItems([{ ...o, kind: 'plot' }])
      if (!items.length) return null
      const range = (v: unknown) =>
        Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number')
          ? (v as [number, number])
          : undefined
      const size = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined)
      return {
        type: 'diagram',
        items,
        w: size(frame.w ?? frame.width),
        h: size(frame.h ?? frame.height),
        x: range(spec.x ?? spec.xrange),
        y: range(spec.y ?? spec.yrange),
        ydown: spec.ydown === true || spec.coords === 'svg' || undefined,
        title: str(o.title) || str(spec.title) || undefined,
        after: after(o.after),
        why,
      }
    }
    case 'table':
    case 'truth_table': {
      const cell = (v: unknown): string =>
        typeof v === 'number' || typeof v === 'boolean' ? String(Number(v)) : str(v)
      const row = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(cell) : null)
      const header = row(o.header ?? o.headers ?? o.columns ?? o.head) ?? undefined
      const body = o.rows ?? o.data ?? o.body
      const rows = Array.isArray(body) ? body.map(row).filter((r): r is string[] => !!r) : []
      if (!rows.length && !header) return null
      const align = row(o.align) ?? undefined
      return {
        type: 'table',
        header,
        rows,
        align,
        title: str(o.title) || undefined,
        after: after(o.after),
        why,
      }
    }
    case 'page':
    case 'new_page':
    case 'newpage':
      return { type: 'page' }
    case 'chat':
    case 'explain':
      return str(o.text) ? { type: 'chat', text: str(o.text) } : null
    case 'say':
    case 'speak':
      return str(o.text) ? { type: 'say', text: str(o.text) } : null
    case 'done':
      return { type: 'done', summary: str(o.summary) || undefined }
    default:
      return null
  }
}

/** LaTeX commands that start with n, which a raw backslash in JSON would read as a line break. */
const LATEX_N =
  /^n(e|eq|eg|u|abla|ot|otin|i|ewline|mid|parallel|leq|geq|less|gtr|exists|subseteq|cong|sim|earrow|warrow|Rightarrow|Leftarrow|leftarrow|rightarrow|atural|ormalsize)(?![a-zA-Z])/

/**
 * Models often forget to escape LaTeX in JSON strings: "\frac" would parse as a form feed
 * plus "rac", "\times" as a tab, and "\Delta" fails outright. Such backslashes are LaTeX,
 * so they get escaped before parsing; real escapes like "\n" (a line break) stay.
 */
export function repairJson(json: string): string {
  let out = ''
  for (let i = 0; i < json.length; i++) {
    const c = json[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const rest = json.slice(i + 1, i + 12)
    if (rest[0] === '\\') {
      out += '\\\\'
      i++
    } else {
      // \D, \, or \{ are invalid JSON anyway; \f, \t… count as LaTeX when a lowercase letter
      // follows. \n is a line break (explanations have many) unless a LaTeX \n… command follows.
      const valid =
        /^(["/]|[bfrt](?![a-z])|u[0-9a-fA-F]{4})/.test(rest) ||
        (rest[0] === 'n' && !LATEX_N.test(rest))
      out += valid ? c : '\\\\'
    }
  }
  return out
}

/**
 * Pulls JSON objects out of a streamed reply. Models wrap lines in code fences, put
 * several objects on one line or pretty-print them; braces are matched (outside strings)
 * so all of those work. Anything that isn't a JSON object is collected as `prose`.
 */
export class InkScriptParser {
  private buf = ''
  private depth = 0
  private inString = false
  private escaped = false
  private start = -1
  private scanned = 0
  /** Text outside any object (a model that ignored the format). */
  prose = ''

  push(chunk: string): InkBlock[] {
    this.buf += chunk
    const out: InkBlock[] = []
    for (let i = this.scanned; i < this.buf.length; i++) {
      const c = this.buf[i]
      if (this.depth === 0) {
        if (c === '{') {
          this.start = i
          this.depth = 1
          this.inString = false
        } else this.prose += c
        continue
      }
      if (this.inString) {
        if (this.escaped) this.escaped = false
        else if (c === '\\') this.escaped = true
        else if (c === '"') this.inString = false
        continue
      }
      if (c === '"') this.inString = true
      else if (c === '{') this.depth++
      else if (c === '}' && --this.depth === 0) {
        const json = this.buf.slice(this.start, i + 1)
        try {
          const block = toBlock(JSON.parse(repairJson(json)))
          if (block) out.push(block)
        } catch {
          // A malformed object is skipped (docs §5.3).
        }
        this.start = -1
      }
    }
    // Keep only an unfinished object.
    if (this.depth > 0 && this.start >= 0) {
      this.buf = this.buf.slice(this.start)
      this.start = 0
    } else this.buf = ''
    this.scanned = this.buf.length
    return out
  }

  /** Prose without code fences and labels, for when no blocks came through. */
  leftover(): string {
    return this.prose.replace(/```(json|jsonl)?/g, '').trim()
  }
}

export function parseInkScript(text: string): InkBlock[] {
  return new InkScriptParser().push(text)
}
