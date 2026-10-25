import { useEffect, useRef, useState } from 'react'
import {
  EraserIcon,
  HighlighterIcon,
  ImageIcon,
  LassoIcon,
  MinusIcon,
  PdfIcon,
  PenIcon,
  PlusIcon,
  RedoIcon,
  TextIcon,
  UndoIcon,
} from './icons'
import {
  ERASER_SIZES,
  HIGHLIGHTER_COLORS,
  HIGHLIGHTER_WIDTHS,
  PEN_COLORS,
  PEN_RANGE,
  PEN_WIDTHS,
  type PenStyle,
  type ToolId,
  type ToolState,
} from './tools'

type Props = {
  tools: ToolState
  onTools(next: ToolState): void
  /** Called when a color is picked, so a lasso selection can be recolored. */
  onColor(color: string): void
  canUndo: boolean
  canRedo: boolean
  onUndo(): void
  onRedo(): void
  onInsertImage(file: File): void
  onImportPdf(file: File): void
  zoom: number
  onZoom(zoom: number): void
}

const TOOLS: {
  id: ToolId
  label: string
  key: string
  Icon: (p: { size?: number }) => React.ReactNode
}[] = [
  { id: 'pen', label: 'Pen', key: 'P', Icon: PenIcon },
  { id: 'highlighter', label: 'Highlighter', key: 'H', Icon: HighlighterIcon },
  { id: 'eraser', label: 'Eraser', key: 'E', Icon: EraserIcon },
  { id: 'lasso', label: 'Lasso', key: 'L', Icon: LassoIcon },
  { id: 'text', label: 'Text', key: 'T', Icon: TextIcon },
]

const PEN_NAMES = ['Fine', 'Medium', 'Bold', 'Marker']
const ERASER_NAMES = ['Small', 'Medium', 'Large', 'Huge']
const TEXT_SIZES = [10, 12, 14, 18, 24, 32]

/** Tool buttons are 40px wide with a 4px gap; the indicator slides by that pitch. */
const TOOL_PITCH = 44

export function Toolbar(p: Props) {
  const { tools } = p
  const [panel, setPanel] = useState(false)
  const set = (patch: Partial<ToolState>) => p.onTools({ ...tools, ...patch })
  const penColor = (color: string) => {
    set({
      tool: tools.tool === 'pen' || tools.tool === 'text' ? tools.tool : 'pen',
      pen: { ...tools.pen, color },
    })
    p.onColor(color)
  }
  const toolIndex = TOOLS.findIndex((t) => t.id === tools.tool)
  const pick = (id: ToolId) => {
    // Tapping the tool you're already on opens its options.
    if (id === tools.tool && (id === 'pen' || id === 'highlighter' || id === 'eraser'))
      setPanel((o) => !o)
    else setPanel(false)
    set({ tool: id })
  }

  return (
    <>
      <div className="toolbar" role="toolbar" aria-label="Tools">
        <div className="group tools">
          <span
            className="tool-indicator"
            style={{ transform: `translateX(${toolIndex * TOOL_PITCH}px)` }}
            aria-hidden="true"
          />
          {TOOLS.map((t) => (
            <button
              type="button"
              key={t.id}
              className={`tool${tools.tool === t.id ? ' on' : ''}`}
              onClick={() => pick(t.id)}
              title={`${t.label} (${t.key})`}
              aria-label={t.label}
              aria-pressed={tools.tool === t.id}
            >
              <t.Icon />
            </button>
          ))}
        </div>

        {(tools.tool === 'pen' || tools.tool === 'text' || tools.tool === 'lasso') && (
          <div className="group options" key={tools.tool}>
            {PEN_COLORS.slice(0, 4).map((c) => (
              <Swatch key={c} color={c} on={tools.pen.color === c} onClick={() => penColor(c)} />
            ))}
            {tools.tool === 'pen' && (
              <button
                type="button"
                className={`size-chip${panel ? ' on' : ''}`}
                onClick={() => setPanel((o) => !o)}
                title="Pen size and color"
                aria-expanded={panel}
              >
                <StrokePreview style={tools.pen} width={46} />
              </button>
            )}
            {tools.tool === 'text' && (
              <span className="stepper" title="Text size">
                <button
                  type="button"
                  onClick={() => set({ textSize: step(TEXT_SIZES, tools.textSize, -1) })}
                  aria-label="Smaller text"
                >
                  A−
                </button>
                <span>{tools.textSize} pt</span>
                <button
                  type="button"
                  onClick={() => set({ textSize: step(TEXT_SIZES, tools.textSize, 1) })}
                  aria-label="Larger text"
                >
                  A+
                </button>
              </span>
            )}
          </div>
        )}

        {tools.tool === 'highlighter' && (
          <div className="group options" key="highlighter">
            {HIGHLIGHTER_COLORS.map((c) => (
              <Swatch
                key={c}
                color={c}
                on={tools.highlighter.color === c}
                onClick={() => set({ highlighter: { ...tools.highlighter, color: c } })}
              />
            ))}
            <span className="divider thin" />
            {HIGHLIGHTER_WIDTHS.map((w) => (
              <button
                type="button"
                key={w}
                className={`width${tools.highlighter.width === w ? ' on' : ''}`}
                onClick={() => set({ highlighter: { ...tools.highlighter, width: w } })}
                title={`Width ${w}`}
                aria-label={`Highlighter width ${w}`}
              >
                <span
                  className="bar"
                  style={{ height: w * 0.7, background: tools.highlighter.color }}
                />
              </button>
            ))}
          </div>
        )}

        {tools.tool === 'eraser' && (
          <div className="group options" key="eraser">
            {ERASER_SIZES.map((s, i) => (
              <button
                type="button"
                key={s}
                className={`width${tools.eraser.size === s ? ' on' : ''}`}
                onClick={() => set({ eraser: { ...tools.eraser, size: s } })}
                title={`${ERASER_NAMES[i]} eraser`}
                aria-label={`${ERASER_NAMES[i]} eraser`}
              >
                <span className="ring" style={{ width: 6 + i * 5, height: 6 + i * 5 }} />
              </button>
            ))}
            <span className="divider thin" />
            <span className="segmented">
              {(['partial', 'stroke'] as const).map((m) => (
                <button
                  type="button"
                  key={m}
                  aria-pressed={tools.eraser.mode === m}
                  className={tools.eraser.mode === m ? 'on' : ''}
                  onClick={() => set({ eraser: { ...tools.eraser, mode: m } })}
                  title={
                    m === 'partial'
                      ? 'Erase only what you rub over'
                      : 'Erase every stroke you touch, whole'
                  }
                >
                  {m === 'partial' ? 'Rub out' : 'Whole stroke'}
                </button>
              ))}
            </span>
          </div>
        )}

        <span className="divider" />

        <div className="group">
          <button
            type="button"
            className="icon"
            onClick={p.onUndo}
            disabled={!p.canUndo}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            <UndoIcon />
          </button>
          <button
            type="button"
            className="icon"
            onClick={p.onRedo}
            disabled={!p.canRedo}
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
          >
            <RedoIcon />
          </button>
        </div>

        <span className="divider" />

        <div className="group">
          <FileButton
            label="Insert image"
            icon={<ImageIcon />}
            accept="image/png,image/jpeg,image/webp,image/gif"
            onFile={p.onInsertImage}
          />
          <FileButton
            label="Import PDF"
            icon={<PdfIcon />}
            accept="application/pdf"
            onFile={p.onImportPdf}
          />
        </div>

        <span className="divider" />

        <div className="group">
          <button
            type="button"
            className="icon"
            onClick={() => p.onZoom(p.zoom / 1.2)}
            title="Zoom out (Ctrl+-)"
            aria-label="Zoom out"
          >
            <MinusIcon />
          </button>
          <button
            type="button"
            className="zoom-label"
            onClick={() => p.onZoom(1)}
            title="Reset zoom (Ctrl+0)"
          >
            {Math.round(p.zoom * 100)}%
          </button>
          <button
            type="button"
            className="icon"
            onClick={() => p.onZoom(p.zoom * 1.2)}
            title="Zoom in (Ctrl+=)"
            aria-label="Zoom in"
          >
            <PlusIcon />
          </button>
        </div>
      </div>
      {panel && tools.tool === 'pen' && (
        <PenPanel
          pen={tools.pen}
          onPen={(pen) => {
            set({ pen })
            if (pen.color !== tools.pen.color) p.onColor(pen.color)
          }}
          onClose={() => setPanel(false)}
        />
      )}
    </>
  )
}

function step(list: number[], value: number, dir: 1 | -1): number {
  const i = list.indexOf(value)
  const at = i < 0 ? list.findIndex((v) => v > value) : i + dir
  return list[Math.max(0, Math.min(list.length - 1, at))] as number
}

function Swatch({ color, on, onClick }: { color: string; on: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      className={`swatch${on ? ' on' : ''}`}
      style={{ background: color }}
      onClick={onClick}
      title={color}
      aria-label={`Color ${color}`}
      aria-pressed={on}
    />
  )
}

/** A short wave drawn at the pen's real width (as it looks at 100% zoom). */
function StrokePreview({ style, width }: { style: PenStyle; width: number }) {
  const h = 22
  const w = Math.max(0.8, style.width * (96 / 72))
  return (
    <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} aria-hidden="true">
      <path
        d={`M4 ${h * 0.65} C ${width * 0.3} ${h * 0.05}, ${width * 0.5} ${h * 1.05}, ${width - 4} ${h * 0.3}`}
        fill="none"
        stroke={style.color}
        strokeWidth={w}
        strokeLinecap="round"
      />
    </svg>
  )
}

function PenPanel({
  pen,
  onPen,
  onClose,
}: {
  pen: PenStyle
  onPen(pen: PenStyle): void
  onClose(): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      if (!ref.current?.contains(t) && !t.closest('.toolbar')) onClose()
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [onClose])

  return (
    <div className="tool-panel" ref={ref} role="dialog" aria-label="Pen">
      <div className="tool-panel-preview">
        <StrokePreview style={pen} width={248} />
      </div>
      <p className="tool-panel-label">
        Size <span>{pen.width.toFixed(1)} pt</span>
      </p>
      <div className="pen-presets">
        {PEN_WIDTHS.map((w, i) => (
          <button
            type="button"
            key={w}
            className={Math.abs(pen.width - w) < 0.05 ? 'on' : ''}
            onClick={() => onPen({ ...pen, width: w })}
          >
            <span style={{ width: w * 2.4 + 2, height: w * 2.4 + 2 }} />
            {PEN_NAMES[i]}
          </button>
        ))}
      </div>
      <input
        type="range"
        className="slider"
        min={PEN_RANGE.min}
        max={PEN_RANGE.max}
        step={PEN_RANGE.step}
        value={pen.width}
        onChange={(e) => onPen({ ...pen, width: Number(e.target.value) })}
        aria-label="Pen size"
      />
      <p className="tool-panel-label">Color</p>
      <div className="pen-colors">
        {PEN_COLORS.map((c) => (
          <Swatch
            key={c}
            color={c}
            on={pen.color === c}
            onClick={() => onPen({ ...pen, color: c })}
          />
        ))}
        <label className="swatch custom" title="Any color">
          <input
            type="color"
            value={pen.color}
            onChange={(e) => onPen({ ...pen, color: e.target.value })}
            aria-label="Any color"
          />
        </label>
      </div>
    </div>
  )
}

function FileButton({
  label,
  icon,
  accept,
  onFile,
}: {
  label: string
  icon: React.ReactNode
  accept: string
  onFile(f: File): void
}) {
  return (
    <label className="file-button icon" title={label}>
      {icon}
      <input
        type="file"
        accept={accept}
        aria-label={label}
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) onFile(f)
        }}
      />
    </label>
  )
}
