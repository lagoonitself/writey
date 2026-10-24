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

const TOOLS: { id: ToolId; label: string; key: string }[] = [
  { id: 'pen', label: 'Pen', key: 'P' },
  { id: 'highlighter', label: 'Highlighter', key: 'H' },
  { id: 'eraser', label: 'Eraser', key: 'E' },
  { id: 'lasso', label: 'Lasso', key: 'L' },
  { id: 'text', label: 'Text', key: 'T' },
]

export function Toolbar(p: Props) {
  const { tools } = p
  const set = (patch: Partial<ToolState>) => p.onTools({ ...tools, ...patch })
  const penColor = (color: string) => {
    set({ tool: 'pen', pen: { ...tools.pen, color } })
    p.onColor(color)
  }

  return (
    <div className="toolbar" role="toolbar">
      <div className="group">
        {TOOLS.map((t) => (
          <button
            type="button"
            key={t.id}
            className={tools.tool === t.id ? 'on' : ''}
            onClick={() => set({ tool: t.id })}
            title={`${t.label} (${t.key})`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {(tools.tool === 'pen' || tools.tool === 'text' || tools.tool === 'lasso') && (
        <div className="group">
          {PEN_PRESETS.map((s) => (
            <button
              type="button"
              key={s.color}
              className={`swatch${tools.pen.color === s.color ? ' on' : ''}`}
              style={{ background: s.color }}
              onClick={() => penColor(s.color)}
              title={s.color}
            />
          ))}
          <input
            type="color"
            className="swatch-picker"
            value={tools.pen.color}
            onChange={(e) => penColor(e.target.value)}
            title="Custom color"
          />
          {tools.tool === 'pen' &&
            PEN_WIDTHS.map((w) => (
              <button
                type="button"
                key={w}
                className={`width${tools.pen.width === w ? ' on' : ''}`}
                onClick={() => set({ pen: { ...tools.pen, width: w } })}
                title={`Width ${w}`}
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
        <div className="group">
          {HIGHLIGHTER_COLORS.map((c) => (
            <button
              type="button"
              key={c}
              className={`swatch${tools.highlighter.color === c ? ' on' : ''}`}
              style={{ background: c }}
              onClick={() => set({ highlighter: { ...tools.highlighter, color: c } })}
              title={c}
            />
          ))}
        </div>
      )}

      <div className="group">
        <button type="button" onClick={p.onUndo} disabled={!p.canUndo} title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button type="button" onClick={p.onRedo} disabled={!p.canRedo} title="Redo (Ctrl+Shift+Z)">
          Redo
        </button>
      </div>

      <div className="group">
        <FileButton
          label="Image"
          accept="image/png,image/jpeg,image/webp,image/gif"
          onFile={p.onInsertImage}
        />
        <FileButton label="Import PDF" accept="application/pdf" onFile={p.onImportPdf} />
      </div>

      <div className="group">
        <button type="button" onClick={() => p.onZoom(p.zoom / 1.2)} title="Zoom out (Ctrl+-)">
          −
        </button>
        <button
          type="button"
          className="zoom-label"
          onClick={() => p.onZoom(1)}
          title="Reset zoom (Ctrl+0)"
        >
          {Math.round(p.zoom * 100)}%
        </button>
        <button type="button" onClick={() => p.onZoom(p.zoom * 1.2)} title="Zoom in (Ctrl+=)">
          +
        </button>
      </div>
    </div>
  )
}

function FileButton({
  label,
  accept,
  onFile,
}: {
  label: string
  accept: string
  onFile(f: File): void
}) {
  return (
    <label className="file-button">
      {label}
      <input
        type="file"
        accept={accept}
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) onFile(f)
        }}
      />
    </label>
  )
}
