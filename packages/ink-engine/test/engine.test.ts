import { describe, expect, it } from 'vitest'
import {
  decodePage,
  encodePage,
  eraseStroke,
  gunzip,
  gzip,
  hitItem,
  type Item,
  itemBounds,
  itemInLasso,
  PageEditor,
  pointInPolygon,
  type Stroke,
  scaleItem,
  translateItem,
} from '../src'

const stroke = (id: string, pts: [number, number][], width = 2): Stroke => ({
  kind: 'stroke',
  id,
  tool: 'pen',
  color: '#000',
  width,
  points: pts.flatMap(([x, y], i) => [x, y, i * 10]),
  author: 'user',
})

const square = [0, 0, 100, 0, 100, 100, 0, 100]

describe('geometry', () => {
  it('bounds include half the stroke width', () => {
    expect(
      itemBounds(
        stroke(
          'a',
          [
            [10, 10],
            [20, 30],
          ],
          4,
        ),
      ),
    ).toEqual({ x: 8, y: 8, w: 14, h: 24 })
  })

  it('hits a stroke near a segment and misses far away', () => {
    const s = stroke('a', [
      [0, 0],
      [100, 0],
    ])
    expect(hitItem(s, 50, 3, 2)).toBe(true)
    expect(hitItem(s, 50, 10, 2)).toBe(false)
  })

  it('hits a single-point stroke (a dot)', () => {
    const dot = stroke('d', [[5, 5]], 4)
    expect(hitItem(dot, 6, 6, 1)).toBe(true)
    expect(hitItem(dot, 20, 20, 1)).toBe(false)
  })

  it('point in polygon', () => {
    expect(pointInPolygon(square, 50, 50)).toBe(true)
    expect(pointInPolygon(square, 150, 50)).toBe(false)
  })

  it('lasso selects strokes mostly inside', () => {
    expect(
      itemInLasso(
        stroke('in', [
          [10, 10],
          [20, 20],
          [30, 30],
        ]),
        square,
      ),
    ).toBe(true)
    expect(
      itemInLasso(
        stroke('out', [
          [10, 10],
          [200, 200],
          [300, 300],
        ]),
        square,
      ),
    ).toBe(false)
  })

  it('translate and scale', () => {
    const s = stroke(
      'a',
      [
        [10, 10],
        [20, 20],
      ],
      2,
    )
    expect(translateItem(s, 5, -5).points).toEqual([15, 5, 0, 25, 15, 10])
    const big = scaleItem(s, 10, 10, 2)
    expect(big.points).toEqual([10, 10, 0, 30, 30, 10])
    expect(big.width).toBe(4)
    expect(s.points).toEqual([10, 10, 0, 20, 20, 10]) // original untouched
    const t: Item = {
      kind: 'text',
      id: 't',
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      text: 'hi',
      size: 12,
      color: '#000',
    }
    expect(scaleItem(t, 0, 0, 2)).toMatchObject({ w: 20, h: 20, size: 24 })
  })
})

describe('PageEditor', () => {
  it('add / remove / replace with undo and redo', () => {
    const ed = new PageEditor()
    const a = stroke('a', [
      [0, 0],
      [1, 1],
    ])
    const b = stroke('b', [
      [2, 2],
      [3, 3],
    ])
    ed.add([a, b])
    ed.remove(new Set(['a']))
    expect(ed.items.map((i) => i.id)).toEqual(['b'])
    ed.replace([translateItem(b, 1, 1)])
    expect((ed.items[0] as Stroke).points[0]).toBe(3)
    ed.undo()
    expect((ed.items[0] as Stroke).points[0]).toBe(2)
    ed.undo()
    expect(ed.items.map((i) => i.id)).toEqual(['a', 'b'])
    ed.redo()
    expect(ed.items.map((i) => i.id)).toEqual(['b'])
    expect(ed.canRedo).toBe(true)
    ed.add([a])
    expect(ed.canRedo).toBe(false)
  })

  it('replace keeps z-order and revision tracks every change', () => {
    const ed = new PageEditor()
    ed.add([stroke('a', [[0, 0]]), stroke('b', [[0, 0]]), stroke('c', [[0, 0]])])
    const r = ed.revision
    ed.replace([{ ...(ed.items[1] as Stroke), color: 'red' }])
    expect(ed.items.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    ed.undo()
    expect(ed.revision).toBe(r + 2)
  })

  it('no-op edits do not create history', () => {
    const ed = new PageEditor()
    ed.remove(new Set(['missing']))
    ed.add([])
    expect(ed.canUndo).toBe(false)
  })
})

describe('serialize', () => {
  it('round-trips through gzip and rounds coordinates', async () => {
    const s: Stroke = { ...stroke('a', [[0, 0]]), points: [1.23456, 2.98765, 3.6] }
    const json = encodePage({ v: 1, items: [s] })
    const back = decodePage(await gunzip(await gzip(json)))
    expect((back.items[0] as Stroke).points).toEqual([1.23, 2.99, 4])
  })

  it('drops malformed items instead of failing', () => {
    const json = JSON.stringify({
      v: 1,
      items: [
        { kind: 'stroke', id: 'x', points: [1, 2] },
        { kind: 'alien', id: 'y' },
        stroke('ok', [[1, 1]]),
      ],
    })
    expect(decodePage(json).items.map((i) => i.id)).toEqual(['ok'])
  })

  it('rejects unknown versions', () => {
    expect(() => decodePage('{"v":2,"items":[]}')).toThrow()
  })
})

describe('partial erase', () => {
  let n = 0
  const id = () => `p${n++}`
  const line = stroke('l', [
    [0, 0],
    [100, 0],
  ])

  it('cuts a stroke in two where the eraser touches', () => {
    const pieces = eraseStroke(line, 50, 0, 5, id)
    expect(pieces).toHaveLength(2)
    const [a, b] = pieces as Stroke[]
    expect(Math.max(...(a as Stroke).points.filter((_, i) => i % 3 === 0))).toBeLessThan(45)
    expect(Math.min(...(b as Stroke).points.filter((_, i) => i % 3 === 0))).toBeGreaterThan(55)
    expect(a?.color).toBe('#000')
  })

  it('returns null when the eraser misses', () => {
    expect(eraseStroke(line, 50, 40, 5, id)).toBeNull()
  })

  it('trims an end and removes a fully covered stroke', () => {
    expect(eraseStroke(line, 0, 0, 5, id)).toHaveLength(1)
    expect(eraseStroke(stroke('d', [[5, 5]]), 5, 5, 5, id)).toEqual([])
  })

  it('splice swaps an item for its pieces in one undo step', () => {
    const ed = new PageEditor({ v: 1, items: [line, stroke('z', [[1, 1]])] })
    ed.splice(new Map([['l', eraseStroke(line, 50, 0, 5, id) as Stroke[]]]))
    expect(ed.items.map((i) => i.id).slice(-1)).toEqual(['z'])
    expect(ed.items).toHaveLength(3)
    ed.undo()
    expect(ed.items.map((i) => i.id)).toEqual(['l', 'z'])
  })
})
