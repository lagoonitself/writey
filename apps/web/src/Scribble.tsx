import { useEffect, useRef } from 'react'

const LIFE_MS = 1400
const INKS = ['#2f4bf0', '#f0304f', '#ffb020', '#0f9d6b', '#7a5cff']

type Dot = { x: number; y: number; t: number; color: string; stroke: number }

/**
 * A full-screen layer where moving the pointer leaves ink that fades away.
 * Each new stroke (after a pause) picks the next ink color.
 */
export function Scribble() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dots: Dot[] = []
    let frame = 0
    let stroke = 0
    let lastMove = 0
    let ratio = 1

    const resize = () => {
      ratio = window.devicePixelRatio || 1
      canvas.width = window.innerWidth * ratio
      canvas.height = window.innerHeight * ratio
    }

    const draw = () => {
      const now = performance.now()
      while (dots.length && now - (dots[0] as Dot).t > LIFE_MS) dots.shift()
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (let i = 1; i < dots.length; i++) {
        const a = dots[i - 1] as Dot
        const b = dots[i] as Dot
        if (a.stroke !== b.stroke) continue
        const life = 1 - (now - b.t) / LIFE_MS
        ctx.globalAlpha = Math.max(0, life)
        ctx.strokeStyle = b.color
        ctx.lineWidth = 2 + life * 3
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
      frame = dots.length ? requestAnimationFrame(draw) : 0
    }

    const onMove = (e: PointerEvent) => {
      const now = performance.now()
      if (now - lastMove > 250) stroke++
      lastMove = now
      const color = INKS[stroke % INKS.length] as string
      const coalesced = e.getCoalescedEvents?.() ?? []
      for (const ev of coalesced.length ? coalesced : [e]) {
        dots.push({ x: ev.clientX, y: ev.clientY, t: now, color, stroke })
      }
      if (!frame) frame = requestAnimationFrame(draw)
    }

    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', onMove)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onMove)
    }
  }, [])

  return <canvas ref={ref} className="scribble" />
}
