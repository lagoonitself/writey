import { describe, expect, it } from 'vitest'
import {
  APPARATUS_NAMES,
  ceToLatex,
  type DiagramItem,
  diagramItems,
  drawDiagram,
  drawnMolecule,
  expandReaction,
  gridLayout,
  layoutMath,
  molBounds,
  molecule,
  parseMath,
  seeded,
  subshells,
  toolBlock,
} from '../src'

const draw = (items: unknown[]) =>
  drawDiagram(
    { items: diagramItems(items) as DiagramItem[] },
    { size: 20, maxW: 500, rng: seeded(2) },
  )

describe('molecules from SMILES', () => {
  it('lays out atoms and bonds a bond length apart', () => {
    const m = molecule('CC(=O)Oc1ccccc1C(=O)O')
    if (!m) throw new Error('aspirin should parse')
    expect(m.atoms.map((a) => a.el).join('')).toBe('CCOOCCCCCCCOO')
    expect(m.rings).toHaveLength(1)
    // Every bond is about one unit long.
    for (const b of m.bonds) {
      const [p, q] = [m.atoms[b.a]?.p, m.atoms[b.b]?.p] as [[number, number], [number, number]]
      expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeCloseTo(1, 1)
    }
    // Oxygens are written as letters; skeletal carbons are not.
    expect(m.atoms.filter((a) => a.shown).every((a) => a.el === 'O')).toBe(true)
  })

  it('returns null for SMILES that do not parse', () => {
    expect(molecule('C1CC(')).toBeNull()
  })

  it('draws open chains straight for displayed formulas', () => {
    const m = drawnMolecule('CCO', true)
    if (!m) throw new Error('ethanol should parse')
    expect(new Set(m.atoms.map((a) => a.p[1].toFixed(3))).size).toBe(1)
    expect(gridLayout(molecule('C1CCCCC1') as never)).toBeNull()
    const b = molBounds(m, true)
    expect(b.x1 - b.x0).toBeGreaterThan(4)
  })

  it('draws Lewis structures with their lone pairs', () => {
    const plain = draw([{ kind: 'molecule', smiles: 'O', hydrogens: 'all' }])
    const lewis = draw([{ kind: 'molecule', smiles: 'O', lewis: true }])
    // Water's oxygen has two lone pairs: four more dots than the plain drawing.
    expect(lewis.paths.length - plain.paths.length).toBe(4)
  })

  it('keeps rings regular (one scale both ways)', () => {
    const d = draw([{ kind: 'molecule', smiles: 'C1=CC=CC=C1' }])
    expect(d.w / d.h).toBeCloseTo(Math.sqrt(3) / 2 / 1, 0)
    expect(Math.abs(d.w / d.h - 0.866)).toBeLessThan(0.15)
  })

  it('draws curly arrows between named atoms and bonds', () => {
    const without = draw([
      { kind: 'molecule', id: 'cn', smiles: '[C-]#N', at: [-3, 0] },
      { kind: 'molecule', id: 'k', smiles: 'CC(=O)C' },
    ])
    const withArrows = draw([
      { kind: 'curly', from: 'cn:C', to: 'k:2' },
      { kind: 'molecule', id: 'cn', smiles: '[C-]#N', at: [-3, 0] },
      { kind: 'molecule', id: 'k', smiles: 'CC(=O)C' },
      { kind: 'curly', from: 'k:2-3', to: 'k:O' },
      { kind: 'curly', from: 'k:9', to: 'k:O' },
    ])
    // Two arrows (a curve and a head each); the one to a missing atom is skipped.
    expect(withArrows.paths.length - without.paths.length).toBe(4)
  })
})

describe('reactions', () => {
  it('lays species out left to right without overlapping', () => {
    const items = expandReaction({
      kind: 'reaction',
      reactants: [{ smiles: 'CC(=O)O' }, { smiles: 'CCO' }],
      products: [{ smiles: 'CC(=O)OCC' }, 'H2O'],
      arrow: '<=>',
      above: 'H2SO4',
    })
    expect(items.map((o) => o.kind)).toEqual([
      'molecule',
      'ctext',
      'molecule',
      'rarrow',
      'molecule',
      'ctext',
      'ctext',
    ])
    const xs = items.map((o) => ((o.at ?? o.from) as [number, number])[0])
    expect([...xs].sort((a, b) => a - b)).toEqual(xs)
    expect(
      draw([{ kind: 'reaction', reactants: ['2H2', 'O2'], products: ['2H2O'] }]).paths.length,
    ).toBeGreaterThan(10)
  })

  it('writes chemical equations with \\ce', () => {
    expect(ceToLatex('2H2O')).toBe('2\\,\\mathrm{H}_{2}\\mathrm{O}')
    expect(ceToLatex('Cu^2+')).toBe('\\mathrm{Cu}^{2+}')
    expect(ceToLatex('OH-')).toBe('\\mathrm{OH}^{−}')
    expect(ceToLatex('NaCl(aq)')).toBe('\\mathrm{NaCl}\\,\\mathrm{(aq)}')
    expect(ceToLatex('A <=>[Fe][heat] B')).toContain(
      '\\xrightleftharpoons[\\mathrm{heat}]{\\mathrm{Fe}}',
    )
    const node = parseMath('\\ce{N2 + 3H2 -> 2NH3}')
    expect(JSON.stringify(node)).toContain('"t":"xarrow"')
    const box = layoutMath('\\ce{CH4 + 2O2 ->[heat] CO2 + 2H2O}', seeded(1))
    expect(box.paths.length).toBeGreaterThan(15)
  })
})

describe('more chemistry', () => {
  it('reads electron configurations', () => {
    expect(subshells('[Ne] 3s2 3p4')).toEqual({
      core: 'Ne',
      shells: [
        { name: '3s', n: 2 },
        { name: '3p', n: 4 },
      ],
    })
  })

  it('draws every kind, every apparatus and every set-up', () => {
    const cases: unknown[][] = [
      [
        {
          kind: 'energy_profile',
          stages: [
            { label: 'R', e: 0 },
            { label: 'TS', e: 50, ts: true },
            { label: 'P', e: -20 },
          ],
        },
      ],
      [{ kind: 'orbital_boxes', config: '1s2 2s2 2p4' }],
      [{ kind: 'lattice', type: 'fcc' }],
      [{ kind: 'newman', front: ['H', 'H', 'CH3'], back: ['H', 'CH3', 'H'] }],
      [{ kind: 'fischer', top: 'CHO', bottom: 'CH2OH', rows: [['H', 'OH']] }],
      [{ kind: 'chair', substituents: [{ at: 1, axial: 'OH' }] }],
      ...APPARATUS_NAMES.map((name) => [{ kind: 'apparatus', name, liquid: 0.4 }]),
      ...['distillation', 'titration', 'gas collection', 'filtration', 'heating'].map((name) => [
        { kind: 'setup', name },
      ]),
    ]
    for (const items of cases) {
      const d = draw(items)
      expect(d.paths.length, JSON.stringify(items)).toBeGreaterThan(0)
      for (const p of d.paths) for (const n of p) expect(Number.isFinite(n)).toBe(true)
    }
  })

  it('takes chemistry through the draw_diagram tool', () => {
    const b = toolBlock(
      'draw_diagram',
      JSON.stringify({ items: [{ kind: 'structure', smiles: 'c1ccccc1O', label: 'phenol' }] }),
    )
    expect(b?.type).toBe('diagram')
  })
})
