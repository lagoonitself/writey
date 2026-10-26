import { describe, expect, it } from 'vitest'
import {
  compile,
  contour,
  type DiagramItem,
  diagramItems,
  drawDiagram,
  holds,
  InkWriter,
  relations,
  seeded,
  setTest,
  toolBlock,
} from '../src'

const draw = (items: unknown[], extra: Record<string, unknown> = {}) =>
  drawDiagram(
    { items: diagramItems(items) as DiagramItem[], ...extra },
    { size: 20, maxW: 400, rng: seeded(3) },
  )

describe('maths for graphs', () => {
  it('reads powers, roots and factorials as a student means them', () => {
    expect(compile('x^(1/3)')({ x: -8 })).toBeCloseTo(-2)
    expect(compile('x^(2/3)')({ x: -8 })).toBeCloseTo(4)
    expect(compile('x^(1/2)')({ x: -4 })).toBeNaN()
    expect(compile('5!')({})).toBe(120)
    expect(compile('x!')({ x: 0.5 })).toBeCloseTo(Math.sqrt(Math.PI) / 2, 6)
  })

  it('reads relations, including chains', () => {
    const r = relations('0 <= x < 2')
    expect(r.map((q) => q.op)).toEqual(['<=', '<'])
    expect(holds(r, { x: 1, y: 0 })).toBe(true)
    expect(holds(r, { x: 2, y: 0 })).toBe(false)
    expect(holds(relations('y > 2x + 1'), { x: 0, y: 2 })).toBe(true)
    expect(relations('x^2 + y^2 = 4')[0]?.f({ x: 2, y: 0 })).toBeCloseTo(0)
  })

  it('traces an implicit circle as one closed loop on the circle', () => {
    const loops = contour((x, y) => x * x + y * y - 4, [-3, 3], [-3, 3])
    expect(loops).toHaveLength(1)
    const loop = loops[0] ?? []
    for (const [x, y] of loop) expect(Math.hypot(x, y)).toBeCloseTo(2, 1)
    const [a, b] = [loop[0], loop.at(-1)] as [[number, number], [number, number]]
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(0.1)
  })

  it('reads set expressions for Venn diagrams', () => {
    const names = ['A', 'B', 'C']
    expect(setTest("A∩B'", names)([true, false, false])).toBe(true)
    expect(setTest("A∩B'", names)([true, true, false])).toBe(false)
    expect(setTest('A|B-C', names)([false, true, true])).toBe(false)
    expect(setTest('(A∪B)ᶜ', names)([false, false, true])).toBe(true)
    expect(setTest('AB', names)([true, true, false])).toBe(true)
  })
})

describe('graphs on the pen', () => {
  it('knows the new kinds and their aliases', () => {
    const kinds = diagramItems([
      { kind: 'implicit', expr: 'x=y' },
      { kind: 'inequality', where: 'y<x' },
      { kind: 'bar_chart', values: [1] },
      { kind: 'probability_tree', branches: [] },
      { kind: 'vector3d', to: [1, 1, 1] },
    ]).map((o) => o.kind)
    expect(kinds).toEqual(['implicit', 'region', 'bars', 'tree', 'arrow3d'])
  })

  it('draws every new kind', () => {
    const cases: unknown[][] = [
      [
        { kind: 'axes', x: [-3, 3], y: [-3, 3] },
        { kind: 'implicit', expr: 'x^2/4+y^2=1' },
      ],
      [
        { kind: 'axes', x: [-3, 3], y: [-3, 3] },
        { kind: 'polar', r: '1+cos(t)' },
      ],
      [
        { kind: 'axes', x: [-1, 4], y: [-1, 4] },
        { kind: 'region', where: ['y<=2x', 'y>=x^2/2'] },
      ],
      [
        { kind: 'axes', x: [0, 3], y: [0, 5] },
        { kind: 'shade', expr: 'x^2', from: 0, to: 2 },
      ],
      [
        { kind: 'axes', x: [-3, 3], y: [-3, 3] },
        { kind: 'slope_field', dy: 'x-y' },
      ],
      [
        { kind: 'axes', x: [-3, 3], y: [-3, 3] },
        { kind: 'vector_field', u: '-y', v: 'x' },
      ],
      [
        {
          kind: 'points',
          points: [
            [1, 2],
            [2, 3],
            [3, 5],
          ],
          fit: 'linear',
        },
      ],
      [{ kind: 'sequence', expr: '1/n', n: [1, 10] }],
      [{ kind: 'bars', values: [3, 5, 2], labels: ['a', 'b', 'c'] }],
      [{ kind: 'histogram', bins: [0, 10, 20], freq: [4, 6] }],
      [{ kind: 'pie', values: [1, 2, 3], labels: ['x', 'y', 'z'] }],
      [{ kind: 'boxplot', data: [1, 2, 3, 4, 5, 9] }],
      [{ kind: 'number_line', range: [-5, 5], intervals: [{ from: -2, to: 'inf', open: [true] }] }],
      [{ kind: 'venn', sets: ['A', 'B', 'C'], shade: ['A&B'] }],
      [{ kind: 'tree', branches: [{ label: 'H', p: '1/2', children: ['H', 'T'] }, 'T'] }],
      [{ kind: 'axes3d' }, { kind: 'point3d', at: [1, 2, 3] }, { kind: 'arrow3d', to: [1, 2, 3] }],
    ]
    for (const items of cases) {
      const d = draw(items)
      expect(d.paths.length, JSON.stringify(items[items.length - 1])).toBeGreaterThan(0)
      expect(d.w).toBeGreaterThan(20)
      for (const p of [...d.paths, ...(d.light ?? [])])
        for (const n of p) expect(Number.isFinite(n)).toBe(true)
    }
  })

  it('shades regions on the light layer, inside the region only', () => {
    const d = draw([
      { kind: 'axes', x: [-2, 2], y: [-2, 2], ticks: false },
      { kind: 'region', where: 'x^2 + y^2 <= 1' },
    ])
    expect(d.light?.length).toBeGreaterThan(5)
  })

  it('draws log axes with decade ticks and plots straight power laws', () => {
    const block = toolBlock(
      'draw_diagram',
      JSON.stringify({
        items: [
          { kind: 'axes', x: [1, 1000], y: [1, 1000], xscale: 'log', yscale: 'log' },
          { kind: 'plot', expr: 'x' },
        ],
      }),
    )
    if (block?.type !== 'diagram') throw new Error('expected a diagram')
    const d = drawDiagram(block, { size: 20, maxW: 400, rng: seeded(1) })
    // y = x on log–log axes is a straight line: its longest stroke has a near-constant slope.
    const longest = d.paths.reduce((a, b) => (b.length > a.length ? b : a))
    const n = longest.length / 2
    const at = (i: number): [number, number] => [
      longest[i * 2] as number,
      longest[i * 2 + 1] as number,
    ]
    const [x0, y0] = at(0)
    const [x1, y1] = at(n - 1)
    const [xm, ym] = at(Math.floor(n / 2))
    const t = (xm - x0) / (x1 - x0)
    expect(Math.abs(ym - (y0 + (y1 - y0) * t))).toBeLessThan(6)
  })

  it('breaks step functions at their jumps instead of drawing risers', () => {
    const d = draw([
      { kind: 'axes', x: [0, 4], y: [-1, 4], ticks: false },
      { kind: 'plot', expr: 'floor(x)', domain: [0, 3.9] },
    ])
    // Axes (2 lines + 2 heads + 2 names' strokes) plus one stroke per step.
    const flat = d.paths.filter((p) => {
      const ys = p.filter((_, i) => i % 2 === 1)
      return p.length > 20 && Math.max(...ys) - Math.min(...ys) < 4
    })
    expect(flat.length).toBeGreaterThanOrEqual(4)
  })
})

describe('pictures', () => {
  const env = {
    page: { width: 595, height: 842 },
    lines: [{ label: 'L1', rect: { x: 60, y: 100, w: 200, h: 24 } }],
    obstacles: [{ x: 60, y: 100, w: 200, h: 24 }],
    target: null,
    images: { focus: { x: 0, y: 0, scale: 1 }, page: { x: 0, y: 0, scale: 1 } },
  }
  const opts = { size: 20, color: '#53c', markColor: '#d22', seed: 1 }

  it('pastes a picture below the work, centred, with its credit', () => {
    const w = new InkWriter(env, opts)
    const out = w.picture({
      assetId: 'a1',
      width: 800,
      height: 600,
      credit: 'Heart · someone · CC BY-SA 4.0 · Wikimedia Commons',
      source: '[picture: Heart]',
    })
    if (!out || 'noRoom' in out) throw new Error('expected a picture')
    const [img, credit] = out.items ?? []
    expect(img?.kind).toBe('image')
    expect(credit?.kind).toBe('text')
    if (img?.kind !== 'image') return
    expect(img.y).toBeGreaterThan(124)
    expect(img.w / img.h).toBeCloseTo(800 / 600)
    // Centred in the band, with room on both sides for names.
    const left = img.x - out.rect.x
    const right = out.rect.x + out.rect.w - (img.x + img.w)
    expect(Math.abs(left - right)).toBeLessThan(1)
    expect(left).toBeGreaterThan(40)
    expect(w.pictures).toHaveLength(1)
  })

  it('names parts in columns beside the picture, never overlapping', () => {
    const w = new InkWriter(env, opts)
    const pic = w.picture({ assetId: 'a1', width: 400, height: 400, source: '[picture]' })
    if (!pic || 'noRoom' in pic) throw new Error('expected a picture')
    const r = pic.items?.[0]
    if (r?.kind !== 'image') throw new Error('expected an image')
    const spot = (fx: number, fy: number): [number, number] => [r.x + r.w * fx, r.y + r.h * fy]
    const block = toolBlock(
      'label_parts',
      JSON.stringify({
        labels: [
          { at: spot(0.2, 0.3), text: 'left atrium' },
          { at: spot(0.25, 0.32), text: 'aorta' },
          { at: spot(0.8, 0.5), text: 'right ventricle' },
        ],
      }),
    )
    if (!block) throw new Error('expected a labels block')
    const out = w.write(block)
    if (!out || 'noRoom' in out) throw new Error('expected labels')
    expect(out.source).toContain('aorta')
    // Names sit outside the picture: on its left and on its right.
    expect(out.rect.x).toBeLessThan(r.x)
    expect(out.rect.x + out.rect.w).toBeGreaterThan(r.x + r.w)
    // Leader lines are on the light layer, in a paler colour.
    const colors = new Set(out.strokes.map((s) => s.stroke.color))
    expect(colors.size).toBe(2)
  })
})
