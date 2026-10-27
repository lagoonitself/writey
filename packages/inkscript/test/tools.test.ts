import { describe, expect, it } from 'vitest'
import { diagramIssues, InkWriter, toolBlock, toolDiagram } from '../src'

const env = {
  page: { width: 595, height: 842 },
  lines: [],
  obstacles: [],
  target: null,
}
const write = (args: Record<string, unknown>, size = 20) => {
  const b = toolBlock('draw_diagram', JSON.stringify(args))
  if (!b) throw new Error('expected a block')
  return new InkWriter(env, { size, color: '#53c', markColor: '#d22', seed: 1 }).write(b)
}
const adder = {
  kind: 'logic',
  inputs: ['A', 'B', 'Cin'],
  gates: [
    { id: 'n1', type: 'nand', in: ['A', 'B'] },
    { id: 'n2', type: 'nand', in: ['A', 'n1'] },
    { id: 'n3', type: 'nand', in: ['B', 'n1'] },
    { id: 'p', type: 'nand', in: ['n2', 'n3'] },
    { id: 'n4', type: 'nand', in: ['p', 'Cin'] },
    { id: 'n5', type: 'nand', in: ['p', 'n4'] },
    { id: 'n6', type: 'nand', in: ['Cin', 'n4'] },
    { id: 's', type: 'nand', in: ['n5', 'n6'] },
    { id: 'c', type: 'nand', in: ['n1', 'n4'] },
  ],
  outputs: { Sum: 's', Cout: 'c' },
}

describe('dedicated drawing tools', () => {
  it('turns a ray diagram into one optics chain, or one lens or mirror', () => {
    const scope = toolDiagram('draw_ray_diagram', {
      elements: [
        { type: 'convex_lens', x: 0, f: 1.5 },
        { type: 'convex_lens', x: 8, f: 3 },
      ],
      object: { x: -2, h: 0.5 },
    })
    expect(scope?.items).toEqual([expect.objectContaining({ kind: 'optics' })])
    const mirror = toolDiagram('draw_ray_diagram', {
      elements: [{ type: 'concave_mirror', x: 0, f: 5 }],
      rays: [{ type: 'parallel', h: 2 }],
    })
    expect(mirror?.items).toEqual([
      expect.objectContaining({ kind: 'mirror', type: 'concave', f: 5 }),
    ])
    expect(toolDiagram('draw_table', {})).toBeNull()
  })

  it('turns a logic circuit into a logic item', () => {
    const d = toolDiagram('draw_logic_circuit', { title: 'NAND adder', ...adder })
    expect(d?.items).toEqual([expect.objectContaining({ kind: 'logic', gates: adder.gates })])
  })

  it('refuses rays drawn by hand, but not a plain sketch', () => {
    const rays = [
      { kind: 'arc', center: [3, 0], r: 3, from: 60, to: -60, label: 'concave mirror' },
      { kind: 'arrow', from: [-4, 4], to: [1.5, 4] },
      { kind: 'line', from: [1.5, 4], to: [3, 0] },
    ]
    expect(diagramIssues(rays).handRays).toBe(true)
    expect(diagramIssues([{ kind: 'line', from: [0, 0], to: [1, 1] }], 'Microscope').handRays).toBe(
      true,
    )
    expect(diagramIssues([{ kind: 'lens', type: 'convex', x: 0, f: 2 }]).handRays).toBe(false)
    expect(diagramIssues([{ kind: 'arrow', from: [0, 0], to: [1, 1], label: 'F' }]).handRays).toBe(
      false,
    )
  })
})

describe('diagrams always fit a page', () => {
  it('draws a big circuit smaller instead of finding no room on a blank page', () => {
    for (const size of [20, 32, 40]) {
      const r = write({ x: [0, 12], y: [0, 10], items: [adder] }, size)
      if (!r || 'noRoom' in r) throw new Error(`no room at size ${size}`)
      expect(r.rect.x + r.rect.w).toBeLessThanOrEqual(595)
      expect(r.rect.y + r.rect.h).toBeLessThanOrEqual(842)
    }
  })

  it('traces two lens items with one object as one instrument', () => {
    const r = write({
      items: [
        { kind: 'lens', type: 'convex', x: 0, f: 1.5, object: { x: -2, h: 0.5 } },
        { kind: 'lens', type: 'convex', x: 8, f: 3 },
      ],
    })
    if (!r || 'noRoom' in r) throw new Error('expected a drawing')
    // Rays reach the eyepiece: ink right of the second lens.
    const xs = r.strokes.flatMap((s) => s.stroke.points.filter((_, i) => i % 3 === 0))
    expect(Math.max(...xs) - r.rect.x).toBeGreaterThan(r.rect.w * 0.8)
  })
})
