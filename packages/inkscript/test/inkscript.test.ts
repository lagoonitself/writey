import { describe, expect, it } from 'vitest'
import {
  circuitTerminals,
  compile,
  type DiagramItem,
  diagramIssues,
  diagramItems,
  drawDiagram,
  drawTable,
  expandFigure,
  FIGURE_NAMES,
  findFigure,
  glyph,
  type InkBlock,
  InkScriptParser,
  InkWriter,
  junctionDots,
  layoutLogic,
  layoutMath,
  layoutParagraph,
  opticsImages,
  Placer,
  parseInkScript,
  parseMath,
  repairJson,
  seeded,
  sizeFromLines,
  splitInline,
  splitRows,
  svgPath,
  toolBlock,
  wirePath,
} from '../src'

const FORMULAS = [
  String.raw`\int x e^x\,dx = x e^x - \int e^x\,dx`,
  String.raw`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`,
  String.raw`\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}`,
  String.raw`\lim_{x \to 0} \frac{\sin x}{x} = 1`,
  String.raw`\vec{F} = q\vec{E} + q\vec{v} \times \vec{B}`,
  String.raw`\int_0^1 x^2\,dx = \left[\frac{x^3}{3}\right]_0^1`,
  String.raw`\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}`,
  String.raw`f(x) = \begin{cases} x^2 & x \ge 0 \\ -x & x < 0 \end{cases}`,
  String.raw`\sqrt[3]{27} = 3,\quad \log_2 8 = 3`,
  String.raw`\boxed{v = 5\,\text{m/s}}`,
]

const allFinite = (paths: number[][]) => paths.every((p) => p.every(Number.isFinite))

describe('glyphs', () => {
  it('cover letters, digits, Greek and math symbols', () => {
    for (const ch of 'aZ09+=()αθπωΔΣ∫∑∞∂∇≤≥≠≈→⇒±×⊕⊗∧∨¬≪≫∵△✓∭') expect(glyph(ch), ch).not.toBeNull()
  })
})

describe('LaTeX', () => {
  it('parses common math into a tree', () => {
    const tree = parseMath(String.raw`\frac{a}{b} + \sqrt{x}^2`)
    expect(tree).toMatchObject({
      t: 'group',
      body: [{ t: 'frac' }, { t: 'sym', ch: '+' }, { t: 'scripts' }],
    })
  })

  it('writes unknown commands as their name instead of failing', () => {
    expect(parseMath(String.raw`\foo x`)).toMatchObject({
      body: [{ t: 'text', text: 'foo' }, { t: 'sym' }],
    })
  })

  it('knows the symbols of logic, sets and school maths', () => {
    const unknown = (tex: string) =>
      JSON.stringify(parseMath(tex)).match(/"t":"text","text":"[a-z]+"/gi) ?? []
    const tex = String.raw`A \oplus B \otimes C \land \lor \neg \wedge \vee a \ll b \gg c \because \triangle \checkmark \iiint \vdots \pmod{5} \bmod`
    expect(unknown(tex)).toEqual([])
  })

  it('survives unbalanced input', () => {
    for (const src of ['}', String.raw`\frac{a`, String.raw`\left( x`, 'x^', String.raw`\right)`]) {
      expect(() => layoutMath(src, seeded(1))).not.toThrow()
    }
  })

  it('splits rows at top-level \\\\ only and strips $ wrappers', () => {
    expect(splitRows(String.raw`$$a \\ b$$`)).toEqual(['a', 'b'])
    expect(splitRows(String.raw`\begin{pmatrix}1\\2\end{pmatrix}`)).toHaveLength(1)
  })

  it('lays out typical formulas with finite, sensible boxes', () => {
    for (const [i, f] of FORMULAS.entries()) {
      const b = layoutMath(f, seeded(i))
      expect(b.paths.length, f).toBeGreaterThan(0)
      expect(allFinite(b.paths), f).toBe(true)
      expect(b.w, f).toBeGreaterThan(0.5)
      expect(b.h + b.d, f).toBeGreaterThan(0.3)
      expect(b.h + b.d, f).toBeLessThan(5)
    }
  })

  it('stacks a fraction: numerator above the bar, denominator below', () => {
    const b = layoutMath(String.raw`\frac{1}{2}`, seeded(1))
    expect(b.h).toBeGreaterThan(0.5)
    expect(b.d).toBeGreaterThan(0.3)
  })

  it('is deterministic for a seed', () => {
    expect(layoutMath('x^2', seeded(7))).toEqual(layoutMath('x^2', seeded(7)))
    expect(layoutMath('x^2', seeded(7))).not.toEqual(layoutMath('x^2', seeded(8)))
  })
})

describe('text', () => {
  it('splits words and inline math', () => {
    expect(splitInline('Let $u = x$, so')).toEqual([
      { kind: 'word', text: 'Let', space: false },
      { kind: 'math', text: 'u = x', space: true },
      { kind: 'word', text: ',', space: false },
      { kind: 'word', text: 'so', space: true },
    ])
  })

  it('wraps to the width', () => {
    const lines = layoutParagraph('one two three four five six seven eight nine ten', 6, seeded(1))
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines.slice(0, -1)) expect(l.w).toBeLessThanOrEqual(6.5)
  })
})

describe('InkScript parser', () => {
  it('repairs unescaped LaTeX in JSON strings', () => {
    expect(
      JSON.parse(repairJson(String.raw`{"latex":"\frac{a}{b} \times \Delta \, x"}`)).latex,
    ).toBe(String.raw`\frac{a}{b} \times \Delta \, x`)
    expect(JSON.parse(repairJson(String.raw`{"latex":"\\frac{1}{2}"}`)).latex).toBe(
      String.raw`\frac{1}{2}`,
    )
    expect(JSON.parse(repairJson(String.raw`{"text":"one\nTwo"}`)).text).toBe('one\nTwo')
    expect(JSON.parse(repairJson(String.raw`{"text":"one\nthen $a \neq b$"}`)).text).toBe(
      String.raw`one
then $a \neq b$`,
    )
  })

  it('reads objects split across chunks, fenced, several per line or pretty-printed', () => {
    const p = new InkScriptParser()
    const chunks = [
      '```json\n{"type":"status","te',
      'xt":"Writing step 2"}\n{"type":"math","latex":"x = {1 \\\\over 2}", "after":"l3"} {"type":"text"',
      ',\n  "text": "So $x$ is {weird}"\n}\n',
      'not json\n{"type":"done"}\n```',
    ]
    const blocks = chunks.flatMap((c) => p.push(c))
    expect(blocks).toEqual([
      { type: 'status', text: 'Writing step 2' },
      { type: 'math', latex: 'x = {1 \\over 2}', after: 'L3', box: false, why: undefined },
      { type: 'text', text: 'So $x$ is {weird}', after: undefined, why: undefined },
      { type: 'done', summary: undefined },
    ])
    expect(p.leftover()).toBe('not json')
  })

  it('drops unusable blocks', () => {
    expect(parseInkScript('{"type":"mark","target":"nowhere"}{"type":"math"}{"type":"x"}')).toEqual(
      [],
    )
  })
})

describe('placement', () => {
  const page = { width: 595, height: 842 }
  const lines = [
    { label: 'L1', rect: { x: 60, y: 100, w: 200, h: 24 } },
    { label: 'L2', rect: { x: 70, y: 140, w: 180, h: 24 } },
  ]

  it('writes below the target line, in the column, skipping work below it', () => {
    const below = { x: 60, y: 175, w: 100, h: 20 }
    const placer = new Placer({
      page,
      lines,
      obstacles: [...lines.map((l) => l.rect), below],
      target: 'L2',
    })
    const spot = placer.place(150, 30, undefined, 6)
    expect(spot?.x).toBe(60)
    expect(spot?.y).toBeGreaterThan(195)
    const next = placer.place(150, 30, 'prev', 6)
    expect(next?.y).toBeGreaterThan((spot?.y ?? 0) + 30)
  })

  it('reports a full page', () => {
    const placer = new Placer({
      page,
      lines,
      obstacles: [{ x: 0, y: 150, w: 595, h: 700 }],
      target: 'L2',
    })
    expect(placer.place(150, 30, 'L2', 6)).toBeNull()
  })

  it('frees the space of erased ink, and "prev" goes back to the block before', () => {
    const placer = new Placer({ page, lines, obstacles: lines.map((l) => l.rect), target: 'L2' })
    const a = placer.place(150, 30, undefined, 6)
    const b = placer.place(150, 30, 'prev', 6)
    if (!a || !b) throw new Error('not placed')
    placer.free({ x: b.x, y: b.y, w: 150, h: 30 })
    expect(placer.place(150, 30, 'prev', 6)?.y).toBe(b.y)
  })

  it('starts near the top of an empty page', () => {
    const placer = new Placer({ page, lines: [], obstacles: [], target: null })
    const spot = placer.place(100, 20, undefined, 6)
    expect(spot?.y).toBeLessThan(100)
  })
})

describe('InkWriter', () => {
  const env = {
    page: { width: 595, height: 842 },
    lines: [{ label: 'L1', rect: { x: 60, y: 100, w: 200, h: 24 } }],
    obstacles: [{ x: 60, y: 100, w: 200, h: 24 }],
    target: 'L1',
  }

  it('writes math as timed AI strokes below the line', () => {
    const w = new InkWriter(env, { size: 20, color: '#53c', markColor: '#d22', seed: 1 })
    const out = w.write({ type: 'math', latex: 'x^2 + 1 = 5' })
    if (!out || 'noRoom' in out) throw new Error('expected ink')
    expect(out.source).toBe('$$x^2 + 1 = 5$$')
    expect(out.rect.y).toBeGreaterThan(124)
    expect(out.strokes.length).toBeGreaterThan(5)
    for (const { stroke } of out.strokes) {
      expect(stroke.author).toBe('ai')
      expect(stroke.groupId).toBe(out.groupId)
      expect(stroke.points.length % 3).toBe(0)
    }
    const starts = out.strokes.map((s) => s.at)
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
    const second = w.write({ type: 'text', text: 'so $x = 2$', after: 'prev' })
    if (!second || 'noRoom' in second) throw new Error('expected ink')
    expect(second.rect.y).toBeGreaterThan(out.rect.y + out.rect.h)
    expect(second.strokes[0]?.at).toBeGreaterThan(starts.at(-1) as number)
  })

  it('marks a line in red with a note', () => {
    const w = new InkWriter(env, { size: 20, color: '#53c', markColor: '#d22', seed: 1 })
    const out = w.write({ type: 'mark', kind: 'circle', target: 'L1', note: 'sign error' })
    if (!out || 'noRoom' in out) throw new Error('expected a mark')
    expect(out.strokes.every((s) => s.stroke.color === '#d22')).toBe(true)
    expect(out.rect.x).toBeLessThan(60)
    expect(w.write({ type: 'mark', kind: 'tick', target: 'L9' })).toBeNull()
  })

  it('marks and writes exactly where the model points, by pixel', () => {
    // Image 2 is the page at 2 px per point; image 1 starts at (50, 80) at 4 px per point.
    const images = { focus: { x: 50, y: 80, scale: 4 }, page: { x: 0, y: 0, scale: 2 } }
    const w = new InkWriter(
      { ...env, images },
      { size: 20, color: '#53c', markColor: '#d22', seed: 1 },
    )
    const [block] = parseInkScript(
      '{"type":"mark","kind":"box","box":[700,1000,800,1100],"img":2,"note":"this resistor"}',
    )
    expect(block).toMatchObject({ kind: 'box', pin: { img: 2, box: [700, 1000, 800, 1100] } })
    const out = w.write(block as InkBlock)
    if (!out || 'noRoom' in out) throw new Error('expected a mark')
    // The box sits around page points (350, 500)–(400, 550); the note and leader go beside it.
    const xs = out.strokes.flatMap((s) => s.stroke.points.filter((_, i) => i % 3 === 0))
    expect(Math.min(...xs)).toBeGreaterThan(330)
    expect(out.rect.y).toBeLessThan(500)
    expect(out.rect.y + out.rect.h).toBeGreaterThan(550)

    const arrow = w.write({ type: 'mark', kind: 'arrow', pin: { img: 1, at: [40, 40] } })
    if (!arrow || 'noRoom' in arrow) throw new Error('expected an arrow')
    // Its head ends at page (60, 90), a few points short so it doesn't cover the spot.
    const head = arrow.strokes.at(-1)?.stroke.points ?? []
    const gaps = []
    for (let i = 0; i < head.length; i += 3) {
      gaps.push(Math.hypot((head[i] as number) - 60, (head[i + 1] as number) - 90))
    }
    expect(Math.min(...gaps)).toBeLessThan(5)

    const label = w.write({ type: 'text', text: 'R1', pin: { img: 2, at: [200, 300] }, size: 20 })
    if (!label || 'noRoom' in label) throw new Error('expected a label')
    expect(label.rect.x).toBeCloseTo(100)
    expect(label.rect.y + label.rect.h / 2).toBeCloseTo(150)

    // Pinned on top of that label, and asked for tiny letters: written readably in the flow instead.
    const clash = w.write({
      type: 'math',
      latex: 'x = 1',
      pin: { img: 2, at: [202, 300] },
      size: 2,
    })
    if (!clash || 'noRoom' in clash) throw new Error('expected a line')
    const over = (a: typeof label.rect, b: typeof label.rect) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    expect(over(clash.rect, label.rect)).toBe(false)
    expect(clash.rect.h).toBeGreaterThan(10)

    // A page without images (a new page) can't take pinned ink.
    const plain = new InkWriter(env, { size: 20, color: '#53c', markColor: '#d22', seed: 1 })
    expect(plain.write({ type: 'mark', kind: 'circle', pin: { img: 2, at: [1, 1] } })).toBeNull()
  })

  it('turns tool calls into blocks, and looks at a line before it writes', () => {
    const blocks = [
      toolBlock('point_at', '{"target":"l1","note":"checking the sign"}'),
      toolBlock('write_math', '{"latex":"\\\\frac{1}{2}","boxed":true,"box":[1,2,3,4]}'),
      toolBlock('write_math', '{"latex":"\\frac{1}{2}"}'),
      toolBlock('look_at_page', '{}'),
      toolBlock('mark', 'not json'),
    ]
    expect(blocks[0]).toEqual({
      type: 'look',
      target: 'L1',
      pin: undefined,
      note: 'checking the sign',
    })
    expect(blocks[1]).toMatchObject({
      type: 'math',
      latex: '\\frac{1}{2}',
      box: true,
      pin: undefined,
    })
    expect(blocks[2]).toMatchObject({ latex: '\\frac{1}{2}', box: false })
    expect(blocks.slice(3)).toEqual([null, null])
    const w = new InkWriter(env, { size: 20, color: '#53c', markColor: '#d22', seed: 1 })
    const look = w.look(blocks[0] as Extract<InkBlock, { type: 'look' }>)
    expect(look).toMatchObject({ x: 160, rect: { x: 60, y: 100 }, at: 0 })
    expect(look?.y).toBeGreaterThan(124)
    // The pen reaches the line before it writes there.
    const out = w.write({ type: 'mark', kind: 'cross', target: 'L1' })
    if (!out || 'noRoom' in out) throw new Error('expected a mark')
    expect(out.strokes[0]?.at).toBeGreaterThan((look?.at ?? 0) + (look?.dur ?? 0))
    expect(w.look({ type: 'look', target: 'L7' })).toBeNull()
  })

  it('matches the student’s writing size', () => {
    expect(sizeFromLines([])).toBe(22)
    expect(sizeFromLines([20, 22, 24])).toBeCloseTo(22 * 1.15)
    expect(sizeFromLines([200])).toBe(40)
  })
})

describe('expressions', () => {
  const at = (src: string, x: number) => compile(src)({ x })

  it('reads the way people write math', () => {
    expect(at('2x^2 - 3x + 1', 2)).toBeCloseTo(3)
    expect(at('sin(x)/x', 0.5)).toBeCloseTo(Math.sin(0.5) / 0.5)
    expect(at('e^(-x) cos(2x)', 1)).toBeCloseTo(Math.exp(-1) * Math.cos(2))
    expect(at('x(x+1)', 3)).toBe(12)
    expect(at('-x^2', 3)).toBe(-9)
    expect(at('2pix', 1)).toBeCloseTo(2 * Math.PI)
    expect(at('sin^2 x + cos^2 x', 0.7)).toBeCloseTo(1)
    expect(at('Math.sqrt(x)**3', 4)).toBeCloseTo(8)
    expect(at('|x - 5|', 2)).toBe(3)
    expect(at('y = x^2', 3)).toBeNaN()
  })

  it('never throws on junk', () => {
    for (const src of ['', ')(', 'foo(x)', '2 +', 'x^^2', 'alert(1)']) {
      expect(() => at(src, 1)).not.toThrow()
    }
  })
})

describe('diagrams', () => {
  it('parse both item forms and nested specs', () => {
    const [a, b, c] = parseInkScript(`
{"type":"diagram","items":[{"kind":"arrow","from":[0,0],"to":[1,1]},{"axes":{"x":[-1,1],"y":[-1,1]}},{"kind":"teapot"}]}
{"type":"diagram","spec":{"frame":{"w":200,"h":120},"items":[{"plot":{"expr":"sin(x)"}}]}}
{"type":"plot","expr":"x^2","x":[-2,2]}`)
    expect(a).toMatchObject({ type: 'diagram', items: [{ kind: 'arrow' }, { kind: 'axes' }] })
    expect(b).toMatchObject({ type: 'diagram', w: 200, h: 120, items: [{ kind: 'plot' }] })
    expect(c).toMatchObject({ type: 'diagram', items: [{ kind: 'plot', expr: 'x^2' }] })
    expect(parseInkScript('{"type":"diagram","items":[]}')).toEqual([])
    expect(parseInkScript('{"type":"page"}')).toEqual([{ type: 'page' }])
  })

  it('draws every primitive as finite pen paths inside its frame', () => {
    const items = diagramItems([
      { kind: 'axes', x: [-1, 7], y: [-2, 2] },
      { kind: 'plot', expr: '1/(x-3)', label: '$y=1/x$' },
      { kind: 'parametric', x: 'cos(t)', y: 'sin(t)' },
      { kind: 'line', from: [0, 0], to: [2, 1], dashed: true },
      { kind: 'rect', at: [1, 1], w: 1, h: 0.5, angle: 30, label: 'm' },
      { kind: 'circle', center: [4, 0], r: 0.5 },
      { kind: 'ellipse', center: [4, 0], rx: 1, ry: 0.4 },
      { kind: 'arc', center: [0, 0], r: 1, from: 0, to: 90 },
      { kind: 'angle', vertex: [0, 0], from: [1, 0], to: [0, 1], right: true },
      {
        kind: 'curve',
        points: [
          [0, 0],
          [1, 1],
          [2, 0],
          [3, 1],
        ],
      },
      {
        kind: 'polygon',
        points: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
      },
      { kind: 'point', at: [3, 0], label: 'P' },
      { kind: 'label', at: [5, 1], text: 'hello', side: 'above' },
      { kind: 'dimension', from: [0, -1], to: [3, -1], label: 'd' },
      { kind: 'hatch', from: [0, -2], to: [6, -2] },
      { kind: 'spring', from: [0, 1], to: [3, 1] },
      { kind: 'pulley', center: [6, 1.5], r: 0.3 },
    ])
    expect(items).toHaveLength(17)
    const d = drawDiagram({ items }, { size: 20, maxW: 400, rng: seeded(1) })
    expect(d.paths.length).toBeGreaterThan(40)
    expect(allFinite(d.paths)).toBe(true)
    for (const p of d.paths) {
      for (let i = 0; i < p.length; i += 2) {
        expect(p[i]).toBeGreaterThanOrEqual(-0.01)
        expect(p[i]).toBeLessThanOrEqual(d.w + 0.01)
        expect(p[i + 1]).toBeGreaterThanOrEqual(-0.01)
        expect(p[i + 1]).toBeLessThanOrEqual(d.h + 0.01)
      }
    }
  })

  it('keeps circles round and graphs inside the y range', () => {
    const d = drawDiagram(
      { items: diagramItems([{ kind: 'circle', center: [0, 0], r: 1 }]) },
      { size: 20, maxW: 400, rng: seeded(2) },
    )
    expect(d.w / d.h).toBeGreaterThan(0.85)
    expect(d.w / d.h).toBeLessThan(1.15)
    const g = drawDiagram(
      {
        x: [-3, 3],
        y: [-1, 1],
        w: 240,
        h: 100,
        items: diagramItems([{ plot: { expr: 'tan(x)' } }]),
      },
      { size: 20, maxW: 400, rng: seeded(2) },
    )
    expect(g.h).toBeLessThan(110)
    expect(g.paths.length).toBeGreaterThan(1)
  })

  it('is placed below the line it follows, as one group', () => {
    const w = new InkWriter(
      {
        page: { width: 595, height: 842 },
        lines: [{ label: 'L1', rect: { x: 60, y: 100, w: 200, h: 24 } }],
        obstacles: [{ x: 60, y: 100, w: 200, h: 24 }],
        target: 'L1',
      },
      { size: 20, color: '#53c', markColor: '#d22', seed: 1 },
    )
    const [block] = parseInkScript(
      '{"type":"diagram","title":"sine","items":[{"kind":"axes","x":[0,7],"y":[-1,1]},{"kind":"plot","expr":"sin(x)"}],"why":"shape"}',
    )
    const out = w.write(block as InkBlock)
    if (!out || 'noRoom' in out) throw new Error('expected a diagram')
    expect(out.rect.y).toBeGreaterThan(124)
    expect(out.source).toMatch(/^\[diagram: sine\] \{/)
    expect(out.why).toBe('shape')
    expect(new Set(out.strokes.map((s) => s.stroke.groupId))).toEqual(new Set([out.groupId]))
    const hl = w.write({ type: 'mark', kind: 'highlight', target: 'L1' })
    if (!hl || 'noRoom' in hl) throw new Error('expected a highlight')
    expect(hl.strokes[0]?.stroke.tool).toBe('highlighter')
  })
})

describe('physics diagrams', () => {
  const one = (item: Record<string, unknown>) => diagramItems([item])[0] as DiagramItem

  it('finds images with the lens and mirror formulas', () => {
    const lens = opticsImages(
      one({ kind: 'lens', type: 'convex', x: 0, f: 10, object: { x: -25, h: 4 } }),
    )
    expect(lens[0]?.x).toBeCloseTo(50 / 3)
    expect(lens[0]?.h).toBeCloseTo(-8 / 3)
    expect(lens[0]?.virtual).toBe(false)
    const magnifier = opticsImages(
      one({ kind: 'lens', type: 'convex', x: 0, f: 10, object: { x: -5, h: 1 } }),
    )
    expect(magnifier[0]).toMatchObject({ virtual: true })
    expect(magnifier[0]?.x).toBeCloseTo(-10)
    // Tiny objects are drawn taller; the image scales with them and keeps its place.
    expect(magnifier[0]?.h).toBeCloseTo(7)
    const concave = opticsImages(
      one({ kind: 'concave_mirror', x: 0, f: 10, object: { x: -30, h: 4 } }),
    )
    expect(concave[0]?.x).toBeCloseTo(-15)
    expect(concave[0]?.h).toBeCloseTo(-2)
    const convex = opticsImages(
      one({ kind: 'mirror', type: 'convex', x: 0, f: 10, object: { x: -10, h: 4 } }),
    )
    expect(convex[0]?.virtual).toBe(true)
    expect(convex[0]?.x).toBeCloseTo(5)
    expect(convex[0]?.h).toBeCloseTo(2)
    const microscope = opticsImages(
      one({
        kind: 'optics',
        elements: [
          { type: 'convex_lens', x: 0, f: 2 },
          { type: 'convex_lens', x: 12, f: 4 },
        ],
        object: { x: -2.5, h: 1 },
      }),
    )
    expect(microscope).toHaveLength(2)
    expect(microscope[0]?.x).toBeCloseTo(10)
    expect(microscope[1]?.virtual).toBe(true)
  })

  it('brings a distant object in as parallel rays meeting in the focal plane', () => {
    const lens = opticsImages(
      one({ kind: 'lens', type: 'convex', x: 0, f: 10, object: 'infinity' }),
    )
    expect(lens[0]?.x).toBeCloseTo(10)
    expect(lens[0]?.h).toBeLessThan(0)
    // A telescope in normal adjustment: the objective's image sits at the eyepiece's focus.
    const telescope = opticsImages(
      one({
        kind: 'optics',
        elements: [
          { type: 'convex_lens', x: 0, f: 20 },
          { type: 'convex_lens', x: 24, f: 4 },
        ],
        object: { x: -200, h: 10 },
      }),
    )
    expect(telescope).toHaveLength(1)
    expect(telescope[0]?.x).toBeCloseTo(20)
  })

  it('keeps circuits at one scale, so a tall column of gates is not squashed', () => {
    const gates = ['and', 'or', 'nand', 'nor', 'xor', 'xnor'].map((type, i) => ({
      id: `g${i}`,
      type,
      in: ['A', 'B'],
    }))
    const logic = {
      kind: 'logic',
      inputs: ['A', 'B'],
      gates,
      outputs: Object.fromEntries(gates.map((g, i) => [`Y${i}`, g.id])),
    }
    const d = drawDiagram({ items: [logic] }, { size: 18, maxW: 480, rng: seeded(1) })
    const L = layoutLogic(logic) as NonNullable<ReturnType<typeof layoutLogic>>
    const xs = L.segs.flat().map((p) => p[0])
    const ys = L.segs.flat().map((p) => p[1])
    const yr = Math.max(...ys) - Math.min(...ys)
    const xr = Math.max(...xs) - Math.min(...xs)
    expect(yr / xr).toBeGreaterThan(1.2)
    expect(d.h / d.w).toBeGreaterThan((yr / xr) * 0.8)
  })

  it('reads gate and transistor aliases as their type', () => {
    expect(one({ kind: 'nand', at: [0, 0] })).toMatchObject({ kind: 'gate', type: 'nand' })
    expect(one({ kind: 'pnp', at: [0, 0] })).toMatchObject({ kind: 'transistor', type: 'pnp' })
    expect(one({ type: 'convex_lens', f: 5 })).toMatchObject({ kind: 'lens', type: 'convex_lens' })
  })

  it('draws every physics kind as finite pen paths', () => {
    const specs: Record<string, unknown>[][] = [
      [
        { kind: 'resistor', from: [0, 0], to: [2, 0], label: 'R', current: 'I' },
        { kind: 'rheostat', from: [2, 0], to: [4, 0] },
        { kind: 'capacitor', from: [4, 0], to: [4, -2] },
        { kind: 'battery', from: [4, -2], to: [2, -2], cells: 3, signs: true },
        { kind: 'cell', from: [2, -2], to: [0, -2], flip: true },
        { kind: 'inductor', from: [0, -2], to: [0, 0] },
        { kind: 'switch', from: [0, 1], to: [2, 1] },
        { kind: 'bulb', from: [2, 1], to: [4, 1] },
        { kind: 'ammeter', from: [0, 2], to: [2, 2] },
        { kind: 'voltmeter', from: [2, 2], to: [4, 2] },
        { kind: 'galvanometer', from: [4, 2], to: [6, 2] },
        { kind: 'diode', from: [0, 3], to: [2, 3] },
        { kind: 'zener', from: [2, 3], to: [4, 3] },
        { kind: 'led', from: [4, 3], to: [6, 3] },
        { kind: 'ac', from: [0, 4], to: [2, 4] },
        { kind: 'fuse', from: [2, 4], to: [4, 4] },
        {
          kind: 'wire',
          points: [
            [4, 4],
            [6, 4],
            [6, 0],
          ],
        },
        { kind: 'junction', at: [2, 0], label: 'A' },
        { kind: 'terminal', at: [6, 0] },
        { kind: 'ground', at: [4, -2] },
        { kind: 'npn', at: [8, 0] },
        { kind: 'transistor', type: 'pnp', at: [8, 3] },
        ...['and', 'or', 'not', 'nand', 'nor', 'xor'].map((t, i) => ({
          kind: 'gate',
          type: t,
          at: [11, i * 1.2],
        })),
      ],
      [{ kind: 'mirror', type: 'concave', x: 0, f: 10, object: { x: -15, h: 3 } }],
      [{ kind: 'lens', type: 'concave', x: 0, f: 10, object: { x: -20, h: 3 }, image: "A'B'" }],
      [{ kind: 'lens', type: 'convex', x: 0, f: 10, object: { x: -10, h: 3 } }],
      [{ kind: 'prism', at: [0, 0], side: 4, apex: 60, n: 1.5, i: 45, deviation: true }],
      [{ kind: 'prism', at: [0, 0], side: 4, apex: 90, n: 1.5, i: 0 }],
      [{ kind: 'slab', at: [0, 0], w: 4, h: 1.5, n: 1.5, i: 40 }],
      [{ kind: 'refraction', at: [0, 0], i: 60, n1: 1.5, n2: 1 }],
      [
        {
          kind: 'charges',
          charges: [
            { at: [-1, 0], q: 2 },
            { at: [1, 0], q: -1 },
          ],
        },
      ],
      [{ kind: 'charges', charges: [{ at: [0, 0], q: -1 }] }],
      [{ kind: 'dipole', at: [0, 0], d: 2 }],
      [{ kind: 'magnet', at: [0, 0], length: 2, north: 'left' }],
      [{ kind: 'solenoid', from: [-2, 0], to: [2, 0], r: 0.6 }],
      [{ kind: 'current', at: [0, 0], dir: 'in' }],
      [
        {
          kind: 'levels',
          levels: [
            { n: 1, e: -13.6 },
            { n: 2, e: -3.4 },
          ],
          transitions: [{ from: 2, to: 1 }],
        },
      ],
      [
        { kind: 'wavefronts', at: [0, 0], r: [1, 2] },
        {
          kind: 'slits',
          x: 3,
          y: [-2, 2],
          gaps: [
            [-0.6, -0.4],
            [0.4, 0.6],
          ],
        },
      ],
    ]
    for (const spec of specs) {
      const items = diagramItems(spec)
      expect(items).toHaveLength(spec.length)
      const d = drawDiagram({ items }, { size: 20, maxW: 400, rng: seeded(4) })
      expect(d.paths.length, JSON.stringify(spec[0])).toBeGreaterThan(2)
      expect(allFinite(d.paths)).toBe(true)
      expect(d.w).toBeLessThan(2000)
      expect(d.h).toBeLessThan(2000)
    }
  })
})

describe('logic circuits', () => {
  const fullAdder = {
    kind: 'logic',
    inputs: ['A', 'B', 'Cin'],
    gates: [
      { id: 'x1', type: 'xor', in: ['A', 'B'] },
      { id: 'x2', type: 'xor', in: ['x1', 'Cin'] },
      { id: 'n1', type: 'nand', in: ['A', 'B'] },
      { id: 'n2', type: 'nand', in: ['x1', 'Cin'] },
      { id: 'n3', type: 'nand', in: ['n1', 'n2'] },
    ],
    outputs: { Sum: 'x2', Cout: 'n3' },
  }

  it('lays gates out in columns with wires that never cross a gate', () => {
    const l = layoutLogic(fullAdder as DiagramItem)
    if (!l) throw new Error('expected a layout')
    expect(l.gates).toHaveLength(5)
    const xs = new Set(l.gates.map((g) => (g.at as number[])[0]))
    expect(xs.size).toBe(3)
    for (const [a, b] of l.segs) {
      // Only straight across or straight up and down.
      expect(Math.abs(a[0] - b[0]) < 1e-9 || Math.abs(a[1] - b[1]) < 1e-9).toBe(true)
      for (const g of l.gates) {
        const [gx, gy] = g.at as number[]
        const x0 = Math.max(Math.min(a[0], b[0]), (gx as number) - 0.55)
        const x1 = Math.min(Math.max(a[0], b[0]), (gx as number) + 0.45)
        const y0 = Math.max(Math.min(a[1], b[1]), (gy as number) - 0.4)
        const y1 = Math.min(Math.max(a[1], b[1]), (gy as number) + 0.4)
        expect(x0 < x1 - 1e-6 && y0 <= y1 + 1e-6, `segment through gate at ${gx},${gy}`).toBe(false)
      }
    }
    expect(l.labels.map((t) => t.text).sort()).toEqual(['A', 'B', 'Cin', 'Cout', 'Sum'])
  })

  it('puts dots on branches, not on crossings', () => {
    expect(
      junctionDots([
        [
          [0, 0],
          [4, 0],
        ],
        [
          [2, 0],
          [2, -2],
        ],
        [
          [1, 1],
          [1, -1],
        ],
      ]),
    ).toEqual([[2, 0]])
  })

  it('draws a logic item at a size that fits the page', () => {
    const d = drawDiagram(
      { items: diagramItems([fullAdder]) },
      { size: 22, maxW: 500, rng: seeded(1) },
    )
    expect(d.w).toBeGreaterThan(350)
    expect(d.w).toBeLessThanOrEqual(520)
    expect(allFinite(d.paths)).toBe(true)
  })

  it('keeps two different wires from running side by side', () => {
    // a1's output and the wire from x1 to a2 used to run 0.05 units apart.
    const adder = {
      kind: 'logic',
      inputs: ['A', 'B', 'Cin'],
      gates: [
        { id: 'x1', type: 'xor', in: ['A', 'B'] },
        { id: 'x2', type: 'xor', in: ['x1', 'Cin'] },
        { id: 'a1', type: 'and', in: ['A', 'B'] },
        { id: 'a2', type: 'and', in: ['x1', 'Cin'] },
        { id: 'o1', type: 'or', in: ['a1', 'a2'] },
      ],
      outputs: { Sum: 'x2', Cout: 'o1' },
    }
    const l = layoutLogic(adder as DiagramItem)
    if (!l) throw new Error('expected a layout')
    const flat = l.segs.filter(([a, b]) => Math.abs(a[1] - b[1]) < 1e-9)
    for (const [a, b] of flat)
      for (const [c, d] of flat) {
        const dy = Math.abs(a[1] - c[1])
        const overlap =
          Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) -
          Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0]))
        expect(dy > 1e-9 && dy < 0.3 && overlap > 0.05, `${a} ${c}`).toBe(false)
      }
  })

  it('draws xnor, buffer and inverter gates, by any common name', () => {
    const l = layoutLogic({
      kind: 'logic',
      inputs: ['A', 'B'],
      gates: [
        { id: 'g1', type: 'XNOR gate', in: ['A', 'B'] },
        { id: 'g2', type: 'buffer', in: ['A', 'B'] },
        { id: 'g3', type: 'inverter', in: ['B'] },
      ],
      outputs: { X: 'g1', Y: 'g2', Z: 'g3' },
    } as DiagramItem)
    expect(l?.gates.map((g) => g.type)).toEqual(['xnor', 'buf', 'not'])
    expect(l?.gates.map((g) => g.inputs)).toEqual([2, 1, 1])
  })

  it('says what is wrong with a diagram, and spots gates drawn as boxes', () => {
    const { problems, gateBoxes } = diagramIssues([
      { kind: 'rect', at: [0, 0], w: 2, h: 1, label: 'AND' },
      { kind: 'lense', x: 0 },
      { kind: 'lens', type: 'convex', x: 0 },
      { kind: 'optics', elements: [{ type: 'convex_lens', x: 0 }] },
    ])
    expect(gateBoxes).toBe(true)
    expect(problems[0]).toMatch(/^item 2: there is no kind "lense" \(nearest: lens/)
    expect(problems.slice(1)).toEqual([
      'item 3 (lens) needs f or focal or focal_length',
      'item 4 (optics) element 1 needs a focal length f',
    ])
    // Real gates next to a labelled box are fine.
    expect(
      diagramIssues([
        { kind: 'and', at: [0, 0] },
        { kind: 'rect', at: [3, 0], label: 'OR' },
      ]).gateBoxes,
    ).toBe(false)
  })

  it('snaps wire ends to pins and turns slanted runs into corners', () => {
    const items = diagramItems([{ kind: 'and', at: [0, 0] }])
    const path = wirePath({ kind: 'wire', from: [-3, 1], to: [-1.1, 0.3] }, circuitTerminals(items))
    expect(path).toEqual([
      [-3, 1],
      [-1, 1],
      [-1, 0.25],
    ])
  })
})

describe('freehand pictures', () => {
  it('reads SVG path data, absolute and relative', () => {
    const [box] = svgPath('M10 10 h20 v10 H10 z')
    expect(box).toEqual([
      [10, 10],
      [30, 10],
      [30, 20],
      [10, 20],
      [10, 10],
    ])
    const curves = svgPath(
      'M0 0 C10 -10 20 -10 30 0 s20 10 30 0 Q70 10 80 0 t20 0 A10 10 0 0 1 120 0 m5 5 l5 5',
    )
    expect(curves).toHaveLength(2)
    const main = curves[0] as number[][]
    expect(main.at(-1)?.[0]).toBeCloseTo(120)
    expect(main.at(-1)?.[1]).toBeCloseTo(0)
    // The arc bulges out by its radius.
    expect(Math.min(...main.map((p) => p[1] as number))).toBeLessThan(-9)
    expect(curves[1]).toEqual([
      [125, 5],
      [130, 10],
    ])
    expect(svgPath('garbage 12 Z')).toEqual([])
  })

  it('keeps y-down drawings the right way up and names parts in columns', () => {
    const items = diagramItems([
      { kind: 'blob', center: [100, 100], rx: 80, ry: 60 },
      { kind: 'circle', center: [100, 60], r: 10 },
      {
        kind: 'callouts',
        labels: [
          { at: [100, 60], text: 'top part' },
          { at: [105, 62], text: 'second' },
          { at: [40, 100], text: 'left part' },
        ],
      },
    ])
    const up = drawDiagram({ items, ydown: true }, { size: 20, maxW: 500, rng: seeded(1) })
    expect(up.w).toBeLessThanOrEqual(505)
    expect(up.w).toBeGreaterThan(300)
    expect(allFinite(up.paths)).toBe(true)
    const [block] = parseInkScript(
      '{"type":"diagram","ydown":true,"items":[{"kind":"svg","d":"M0 0 L10 10"},{"kind":"callouts","labels":[{"at":[5,5],"text":"x"}]}]}',
    )
    expect(block).toMatchObject({ type: 'diagram', ydown: true })
    expect(diagramItems([{ kind: 'callouts', labels: [] }])).toHaveLength(1)
  })

  it('bends the textbook ray rules for a concave mirror', () => {
    const items = diagramItems([
      {
        kind: 'mirror',
        type: 'concave',
        x: 0,
        f: 5,
        rays: ['parallel', { type: 'focus', h: -1 }, 'centre', 'pole'],
      },
    ])
    const d = drawDiagram({ items }, { size: 20, maxW: 500, rng: seeded(1) })
    expect(d.paths.length).toBeGreaterThan(10)
    expect(allFinite(d.paths)).toBe(true)
  })
})

describe('tables and figures', () => {
  it('parses a truth table and rules a grid around its cells', () => {
    const [b] = parseInkScript(
      '{"type":"table","header":["A","B","Y"],"rows":[[0,0,0],[0,1,1],[1,0,1],[1,1,0]]}',
    )
    expect(b?.type).toBe('table')
    if (b?.type !== 'table') return
    expect(b.rows[1]).toEqual(['0', '1', '1'])
    const t = drawTable(b, seeded(1))
    expect(t.w).toBeGreaterThan(3)
    // Frame (4) + 4 row rules + header double rule + 2 column rules, then the cells.
    expect(t.paths.length).toBeGreaterThan(11 + 15)
  })

  it('finds library figures by everyday names and labels the parts asked for', () => {
    expect(findFigure('the human heart')?.title).toMatch(/heart/i)
    expect(findFigure('L.S. of flower')?.title).toMatch(/flower/i)
    expect(findFigure('plant cell')?.title).toMatch(/plant/i)
    expect(findFigure('spaceship')).toBeNull()
    const items = expandFigure({ kind: 'figure', name: 'flower', labels: ['stamen', 'ovary'] })
    const callouts = items?.find((o) => o.kind === 'callouts')
    const names = ((callouts?.labels ?? []) as { text: string }[]).map((l) => l.text)
    expect(names.sort()).toEqual(['anther', 'filament', 'ovary'])
  })

  it('draws every library figure', () => {
    for (const name of FIGURE_NAMES) {
      const d = drawDiagram(
        { items: [{ kind: 'figure', name }] },
        { size: 20, maxW: 500, rng: seeded(2) },
      )
      expect(d.paths.length, name).toBeGreaterThan(5)
      expect(d.w, name).toBeLessThanOrEqual(520)
    }
  })
})
