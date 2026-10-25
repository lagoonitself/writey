import { newId, type Stroke } from '@writey/ink-engine'
import type { Path } from './layout'

// Turns pen paths (page points) into strokes with human-ish timing, so AI ink can be
// animated as it is "written".

/** Writing speed in points per millisecond (about twice a calm human hand). */
const SPEED = 0.3
const PEN_UP_MS = 45
const RESAMPLE_PT = 0.7

export type TimedStroke = { stroke: Stroke; at: number }

export type PenOptions = {
  color: string
  width: number
  groupId: string
  startAt: number
  tool?: 'pen' | 'highlighter'
  /** Speed factor: diagrams go a little quicker than writing. */
  speed?: number
}

function resample(p: Path): number[][] {
  const pts: number[][] = []
  for (let i = 0; i + 1 < p.length; i += 2) {
    const x = p[i] as number
    const y = p[i + 1] as number
    const last = pts.at(-1)
    if (!last) {
      pts.push([x, y])
      continue
    }
    const dist = Math.hypot(x - (last[0] as number), y - (last[1] as number))
    const n = Math.floor(dist / RESAMPLE_PT)
    for (let k = 1; k <= n; k++) {
      const t = (k * RESAMPLE_PT) / dist
      pts.push([
        (last[0] as number) + (x - (last[0] as number)) * t,
        (last[1] as number) + (y - (last[1] as number)) * t,
      ])
    }
    const end = pts.at(-1) as number[]
    if (Math.hypot(x - (end[0] as number), y - (end[1] as number)) > 0.05) pts.push([x, y])
  }
  // A dot still needs a little length to show up.
  if (pts.length === 1) {
    const [x, y] = pts[0] as number[]
    pts.push([(x as number) + 0.4, (y as number) + 0.3])
  }
  return pts
}

/** Strokes for paths drawn one after another, starting at `startAt` ms. */
export function penStrokes(
  paths: readonly Path[],
  opts: PenOptions,
): { strokes: TimedStroke[]; end: number } {
  const strokes: TimedStroke[] = []
  const speed = SPEED * (opts.speed ?? 1)
  let t = opts.startAt
  let prev: number[] | null = null
  for (const path of paths) {
    const pts = resample(path)
    if (pts.length < 2) continue
    const first = pts[0] as number[]
    if (prev) {
      const travel = Math.hypot(
        (first[0] as number) - (prev[0] as number),
        (first[1] as number) - (prev[1] as number),
      )
      t += PEN_UP_MS + travel / (speed * 4)
    }
    const flat: number[] = []
    let local = 0
    pts.forEach((p, i) => {
      if (i > 0) {
        const q = pts[i - 1] as number[]
        local +=
          Math.hypot((p[0] as number) - (q[0] as number), (p[1] as number) - (q[1] as number)) /
          speed
      }
      flat.push(p[0] as number, p[1] as number, Math.round(local))
    })
    strokes.push({
      at: Math.round(t),
      stroke: {
        kind: 'stroke',
        id: newId(),
        tool: opts.tool ?? 'pen',
        color: opts.color,
        width: opts.width,
        points: flat,
        author: 'ai',
        groupId: opts.groupId,
      },
    })
    t += local
    prev = pts.at(-1) as number[]
  }
  return { strokes, end: Math.round(t) }
}
