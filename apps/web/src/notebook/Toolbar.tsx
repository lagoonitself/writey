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
import { HIGHLIGHTER_COLORS, PEN_PRESETS, PEN_WIDTHS, type ToolId, type ToolState } from './tools'

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

/** Tool buttons are 40px wide with a 4px gap; the indicator slides by that pitch. */
const TOOL_PITCH = 44

export function Toolbar(p: Props) {
  const { tools } = p
  const set = (patch: Partial<ToolState>) => p.onTools({ ...tools, ...patch })
  const penColor = (color: string) => {
    set({ tool: 'pen', pen: { ...tools.pen, color } })
    p.onColor(color)
  }
  const toolIndex = TOOLS.findIndex((t) => t.id === tools.tool)

  return (
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
            onClick={() => set({ tool: t.id })}
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
          {PEN_PRESETS.map((s) => (
            <button
              type="button"
              key={s.color}
              className={`swatch${tools.pen.color === s.color ? ' on' : ''}`}
              style={{ background: s.color }}
              onClick={() => penColor(s.color)}
              title={s.color}
              aria-label={`Color ${s.color}`}
            />
          ))}
          <input
            type="color"
            className="swatch-picker"
            value={tools.pen.color}
            onChange={(e) => penColor(e.target.value)}
            title="Custom color"
            aria-label="Custom color"
          />
          {tools.tool === 'pen' &&
            PEN_WIDTHS.map((w) => (
              <button
                type="button"
                key={w}
                className={`width${tools.pen.width === w ? ' on' : ''}`}
                onClick={() => set({ pen: { ...tools.pen, width: w } })}
                title={`Width ${w}`}
                aria-label={`Width ${w}`}
              >
                <span style={{ width: w * 3 + 2, height: w * 3 + 2 }} />
              </button>
            ))}
          {tools.tool === 'text' && (
            <select
              value={tools.textSize}
              onChange={(e) => set({ textSize: Number(e.target.value) })}
              title="Text size"
            >
              {[10, 12, 14, 18, 24, 32].map((s) => (
                <option key={s} value={s}>
                  {s} pt
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {tools.tool === 'highlighter' && (
        <div className="group options" key="highlighter">
          {HIGHLIGHTER_COLORS.map((c) => (
            <button
              type="button"
              key={c}
              className={`swatch${tools.highlighter.color === c ? ' on' : ''}`}
              style={{ background: c }}
              onClick={() => set({ highlighter: { ...tools.highlighter, color: c } })}
              title={c}
              aria-label={`Highlighter ${c}`}
            />
          ))}
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
