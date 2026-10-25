// Builds src/glyphs.data.ts: single-stroke glyphs for Writey's handwriting (docs §5.5).
// Latin letters, digits and punctuation come from EMS Allure (SIL OFL, fonts/OFL.txt);
// Greek and math symbols from the Hershey fonts, scaled to match. A few symbols neither
// has are composed from parts. Run: pnpm --filter @writey/inkscript glyphs
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const pkg = dirname(require.resolve('hersheytext/package.json'))
const hershey = JSON.parse(readFileSync(join(pkg, 'hersheytext.json'), 'utf8'))
const allureSvg = readFileSync(join(pkg, 'svg_fonts', 'EMSAllure.svg'), 'utf8')

/** Glyph = { w: advance, s: strokes as flat [x, y, x, y, …] }, in 1/1000 em, y down, baseline 0. */
const out = {}

// ---- SVG path → polylines (M, L, C; absolute) ----
function parsePath(d, map) {
  const strokes = []
  let cur = null
  let x = 0
  let y = 0
  const tokens = d.match(/[MLCmlc]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
  let cmd = 'M'
  let i = 0
  const num = () => Number(tokens[i++])
  while (i < tokens.length) {
    if (/[MLC]/i.test(tokens[i])) cmd = tokens[i++]
    if (cmd === 'M') {
      x = num()
      y = num()
      cur = [...map(x, y)]
      strokes.push(cur)
      cmd = 'L'
    } else if (cmd === 'L') {
      x = num()
      y = num()
      cur.push(...map(x, y))
    } else if (cmd === 'C') {
      const [x1, y1, x2, y2, x3, y3] = [num(), num(), num(), num(), num(), num()]
      for (let k = 1; k <= 8; k++) {
        const t = k / 8
        const u = 1 - t
        const px = u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3
        const py = u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3
        cur.push(...map(px, py))
      }
      x = x3
      y = y3
    } else throw new Error(`Unsupported path command ${cmd}`)
  }
  return strokes.filter((s) => s.length >= 2)
}

const round = (s) => s.map((n) => Math.round(n))

// ---- EMS Allure (units-per-em 1000, y up) ----
const entity = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
for (const m of allureSvg.matchAll(/<glyph ([^>]*?)\/>/g)) {
  const attr = Object.fromEntries(
    [...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]),
  )
  if (attr.unicode === undefined) continue
  const ch = entity(attr.unicode)
  if ([...ch].length !== 1) continue
  const strokes = attr.d ? parsePath(attr.d, (px, py) => [px, -py]) : []
  out[ch] = { w: Math.round(Number(attr['horiz-adv-x'])), s: strokes.map(round) }
}

// ---- Hershey: chars[i] is ASCII 33 + i; y down, baseline at the bottom of 'H' ----
function bounds(strokes) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const s of strokes)
    for (let i = 0; i < s.length; i += 2) {
      x0 = Math.min(x0, s[i])
      x1 = Math.max(x1, s[i])
      y0 = Math.min(y0, s[i + 1])
      y1 = Math.max(y1, s[i + 1])
    }
  return { x0, y0, x1, y1 }
}
const rawHershey = (font, ch) => {
  const g = hershey[font].chars[ch.charCodeAt(0) - 33]
  if (!g) throw new Error(`${font} has no ${ch}`)
  return { o: g.o, s: parsePath(g.d, (px, py) => [px, py]) }
}
// Script letters have swashes, so measure plain shapes: 'o' for x-height, '1' for caps.
const hH = bounds(rawHershey('futural', '1').s)
const hx = bounds(rawHershey('futural', 'o').s)
const aH = bounds(out['1'].s)
const ax = bounds(out.o.s)
// Match x-height and digit height halfway, so Greek sits naturally beside Allure letters.
const scale = ((ax.y1 - ax.y0) / (hx.y1 - hx.y0) + (aH.y1 - aH.y0) / (hH.y1 - hH.y0)) / 2
const baseline = hH.y1
const SIDE = 40 // side bearing, 1/1000 em

function fromHershey(font, ch) {
  const g = rawHershey(font, ch)
  const b = bounds(g.s)
  const strokes = g.s.map((s) =>
    round(s.map((n, i) => (i % 2 === 0 ? (n - b.x0) * scale + SIDE : (n - baseline) * scale))),
  )
  return { w: Math.round((b.x1 - b.x0) * scale + SIDE * 2), s: strokes }
}

const GREEK = {
  a: 'α',
  b: 'β',
  c: 'χ',
  d: 'δ',
  e: 'ε',
  f: 'φ',
  g: 'γ',
  h: 'η',
  i: 'ι',
  k: 'κ',
  l: 'λ',
  m: 'μ',
  n: 'ν',
  o: 'ο',
  p: 'π',
  q: 'θ',
  r: 'ρ',
  s: 'σ',
  t: 'τ',
  u: 'υ',
  w: 'ω',
  x: 'ξ',
  y: 'ψ',
  z: 'ζ',
  A: 'Α',
  B: 'Β',
  C: 'Χ',
  D: 'Δ',
  E: 'Ε',
  F: 'Φ',
  G: 'Γ',
  H: 'Η',
  I: 'Ι',
  K: 'Κ',
  L: 'Λ',
  M: 'Μ',
  N: 'Ν',
  O: 'Ο',
  P: 'Π',
  Q: 'Θ',
  R: 'Ρ',
  S: 'Σ',
  T: 'Τ',
  U: 'Υ',
  W: 'Ω',
  X: 'Ξ',
  Y: 'Ψ',
  Z: 'Ζ',
}
for (const [k, v] of Object.entries(GREEK)) out[v] = fromHershey('greek', k)

{
  // Hershey's lowercase theta is the curly variant; students write an oval with a bar.
  const zero = fromHershey('futural', '0')
  const b = bounds(zero.s)
  const k = 0.62
  const s = zero.s.map((p) =>
    p.map((n, i) => Math.round(i % 2 === 0 ? (n - b.x0) * k + SIDE : n * k)),
  )
  const zb = bounds(s)
  const y = Math.round((zb.y0 + zb.y1) / 2)
  out['θ'] = { w: Math.round(zb.x1 + SIDE), s: [...s, [zb.x0, y, zb.x1, y]] }
}

const MATH = {
  '!': '±',
  '"': '∓',
  '#': '×',
  $: '⋅',
  '&': '≤',
  "'": '≥',
  ':': '∏',
  ';': '∑',
  '?': '≠',
  '@': '≡',
  '^': '∝',
  _: '∞',
  d: '⊂',
  e: '∪',
  f: '⊃',
  g: '∩',
  h: '∈',
  i: '→',
  j: '↑',
  k: '←',
  l: '↓',
  m: '∂',
  n: '∇',
  p: '∫',
  v: '∃',
  x: '÷',
  y: '‖',
  z: '⊥',
  '|': '∠',
  '~': '∴',
}
for (const [k, v] of Object.entries(MATH)) out[v] = fromHershey('mathlow', k)

// ---- Composites ----
const shift = (g, dx, dy) => g.s.map((s) => s.map((n, i) => n + (i % 2 === 0 ? dx : dy)))
const compose = (w, ...parts) => ({ w, s: parts.flat() })
const tilde = fromHershey('futural', '~')
const eq = fromHershey('mathlow', '=')
const arrowR = out['→']
const arrowL = out['←']
const tb = bounds(tilde.s)
const em = (n) => Math.round(n)
out['≈'] = compose(tilde.w, shift(tilde, 0, -70), shift(tilde, 0, 70))
out['∼'] = tilde
out['≅'] = compose(eq.w, shift(tilde, 0, -(tb.y1 - tb.y0) - 90), eq.s)
out['↔'] = compose(arrowR.w, arrowR.s, arrowL.s)
{
  // Double arrows: two shafts and one head.
  const b = bounds(arrowR.s)
  const midY = (b.y0 + b.y1) / 2
  const x0 = b.x0
  const x1 = b.x1
  const gap = 45
  const head = [x1 - 110, midY - 110, x1, midY, x1 - 110, midY + 110]
  const headL = [x0 + 110, midY - 110, x0, midY, x0 + 110, midY + 110]
  const shafts = (a, z) => [
    [em(a), em(midY - gap), em(z), em(midY - gap)],
    [em(a), em(midY + gap), em(z), em(midY + gap)],
  ]
  out['⇒'] = { w: arrowR.w, s: [...shafts(x0, x1 - 30), head.map(em)] }
  out['⇐'] = { w: arrowR.w, s: [...shafts(x0 + 30, x1), headL.map(em)] }
  out['⇔'] = { w: arrowR.w, s: [...shafts(x0 + 30, x1 - 30), head.map(em), headL.map(em)] }
}
{
  const A = fromHershey('futural', 'A')
  const b = bounds(A.s)
  out['∀'] = { w: A.w, s: A.s.map((s) => s.map((n, i) => (i % 2 ? b.y0 + b.y1 - n : n))) }
}
{
  const inn = out['∈']
  const b = bounds(inn.s)
  out['∉'] = compose(inn.w, inn.s, [[em(b.x1 - 20), em(b.y0 - 60), em(b.x0 + 20), em(b.y1 + 60)]])
  const O = fromHershey('futural', 'O')
  const o = bounds(O.s)
  out['∅'] = compose(O.w, O.s, [[em(o.x1 + 30), em(o.y0 - 40), em(o.x0 - 30), em(o.y1 + 40)]])
  const sub = out['⊂']
  const sb = bounds(sub.s)
  out['⊆'] = compose(sub.w, shift(sub, 0, -80), [[sb.x0, sb.y1 + 40, sb.x1, sb.y1 + 40]])
  const sup = out['⊃']
  const pb = bounds(sup.s)
  out['⊇'] = compose(sup.w, shift(sup, 0, -80), [[pb.x0, pb.y1 + 40, pb.x1, pb.y1 + 40]])
}
{
  const h = out.h
  const b = bounds(h.s)
  // ħ: Allure's h with a short bar through the ascender.
  const y = em(b.y0 + (b.y1 - b.y0) * 0.3)
  out['ℏ'] = compose(h.w, h.s, [[em(b.x0 + 60), y + 30, em(b.x0 + 300), y - 30]])
}
{
  const circle = (cx, cy, r, n = 16) =>
    Array.from({ length: n + 1 }, (_, k) => [
      em(cx + r * Math.cos((k / n) * 2 * Math.PI)),
      em(cy + r * Math.sin((k / n) * 2 * Math.PI)),
    ]).flat()
  out['∘'] = { w: 300, s: [circle(150, -250, 70)] }
  out['°'] = { w: 260, s: [circle(130, -560, 55)] }
  const int = out['∫']
  const ib = bounds(int.s)
  out['∮'] = compose(int.w, int.s, [circle((ib.x0 + ib.x1) / 2, (ib.y0 + ib.y1) / 2, 110)])
  out['∬'] = compose(int.w + 180, int.s, shift(int, 180, 0))
  out['′'] = { w: 160, s: [[130, -620, 60, -430]] }
  out['…'] = {
    w: 700,
    s: [100, 330, 560].map((x) => circle(x + 30, -20, 18, 6)),
  }
  out['⋯'] = {
    w: 700,
    s: [100, 330, 560].map((x) => circle(x + 30, -250, 18, 6)),
  }
}

const keys = Object.keys(out).sort()
const body = keys
  .map((k) => `${JSON.stringify(k)}:[${out[k].w},${JSON.stringify(out[k].s)}]`)
  .join(',\n')
const file = `// Generated by scripts/build-glyphs.mjs from EMS Allure (SIL OFL 1.1, see fonts/OFL.txt)
// and the Hershey fonts (via hersheytext, MIT). Do not edit by hand.
// [advance, strokes as flat [x, y, x, y, …]] in 1/1000 em, y down, baseline at 0.

export const GLYPHS: Record<string, [number, number[][]]> = {
${body},
}
`
writeFileSync(join(here, '..', 'src', 'glyphs.data.ts'), file)
console.log(`${keys.length} glyphs, Hershey scale ${scale.toFixed(2)}`)
