import type { PageRow } from '@writey/shared'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PageController, type TextEdit } from './pageController'
import {
  dotCursor,
  type GhostView,
  type PageHandle,
  type SaveState,
  type ToolId,
  type ToolState,
} from './tools'

type Props = {
  page: PageRow
  number: number
  /** CSS pixels per PDF point. */
  scale: number
  tools: ToolState
  active: boolean
  handles: Map<string, PageHandle>
  onActivate(pageId: string): void
  onHistory(): void
  onSaveState(pageId: string, state: SaveState): void
  onRequestTool(tool: ToolId): void
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

export function PageView(props: Props) {
  const { page, scale, tools, active, handles } = props
  const latest = useRef(props)
  latest.current = props

  const wrapRef = useRef<HTMLDivElement>(null)
  const bgRef = useRef<HTMLCanvasElement>(null)
  const inkRef = useRef<HTMLCanvasElement>(null)
  const wetRef = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null)
  const [ghost, setGhost] = useState<GhostView | null>(null)

  // One controller per page for the component's lifetime (the parent keys us by page id).
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately created once
  const ctl = useMemo(
    () =>
      new PageController(page, tools, {
        onHistory: () => latest.current.onHistory(),
        onSaveState: (s) => latest.current.onSaveState(page.id, s),
        onTextEdit: setTextEdit,
        onActivate: () => latest.current.onActivate(page.id),
        onRequestTool: (t) => latest.current.onRequestTool(t),
        onGhost: setGhost,
      }),
    [],
  )

  useEffect(() => {
    handles.set(page.id, ctl.handle)
    return () => {
      handles.delete(page.id)
      void ctl.flush()
    }
  }, [ctl, handles, page.id])

  // Only pages near the viewport get canvases.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), {
      rootMargin: '800px 0px',
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible || loadState !== 'idle') return
    setLoadState('loading')
    ctl.load().then(
      () => setLoadState('ready'),
      (err: unknown) => {
        console.error('page load failed', err)
        setLoadState('error')
      },
    )
  }, [visible, loadState, ctl])

  useLayoutEffect(() => {
    if (!visible || !bgRef.current || !inkRef.current || !wetRef.current) return
    ctl.attach(bgRef.current, inkRef.current, wetRef.current)
    ctl.layout(scale)
    return () => ctl.detach()
  }, [visible, scale, ctl])

  useEffect(() => ctl.setTools(tools), [tools, ctl])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (!isTyping(e.target) && ctl.keyDown(e)) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, ctl])

  return (
    <div
      ref={wrapRef}
      id={`page-${page.id}`}
      className={`page tool-${tools.tool}${active ? ' active' : ''}`}
      style={{ width: page.width * scale, height: page.height * scale }}
    >
      {visible && (
        <>
          <canvas ref={bgRef} className="layer" />
          <canvas ref={inkRef} className="layer" />
          <canvas
            ref={wetRef}
            className="layer wet"
            style={{ cursor: cursorFor(tools, scale) }}
            onPointerDown={(e) => ctl.pointerDown(e.nativeEvent)}
            onPointerMove={(e) => ctl.pointerMove(e.nativeEvent)}
            onPointerUp={() => ctl.pointerUp()}
            onPointerCancel={() => ctl.pointerUp()}
            onPointerLeave={() => ctl.pointerLeave()}
          />
        </>
      )}
      {loadState === 'loading' && <div className="page-status">Loading…</div>}
      {loadState === 'error' && (
        <div className="page-status error">
          Couldn't load this page.{' '}
          <button type="button" onClick={() => setLoadState('idle')}>
            Retry
          </button>
        </div>
      )}
      {textEdit && (
        <TextEditor
          edit={textEdit}
          scale={scale}
          onDone={(text) => ctl.commitText(textEdit, text)}
        />
      )}
      {ghost && <GhostBar view={ghost} scale={scale} page={page} ctl={ctl} />}
      <span className="page-number">{props.number}</span>
    </div>
  )
}

function cursorFor(tools: ToolState, scale: number): string | undefined {
  if (tools.tool === 'pen') return dotCursor(tools.pen.color, tools.pen.width * scale + 5)
  if (tools.tool === 'highlighter') {
    return dotCursor(tools.highlighter.color, tools.highlighter.width * scale * 0.6, '#1d1c19')
  }
  return undefined
}

/** Accept · Redo · Discard · Why? under Writey's preview ink (docs §5.7). */
function GhostBar({
  view,
  scale,
  page,
  ctl,
}: {
  view: GhostView
  scale: number
  page: PageRow
  ctl: PageController
}) {
  const ref = useRef<HTMLDivElement>(null)
  const shown = view.rect.w > 0
  // Bring the new ink into view once it starts appearing.
  useEffect(() => {
    if (shown) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [shown])
  if (!shown) return null
  const top = Math.min((view.rect.y + view.rect.h) * scale + 10, page.height * scale - 48)
  const left = Math.max(8, Math.min(view.rect.x * scale, page.width * scale - 330))
  return (
    <div
      className="ghost-bar"
      ref={ref}
      style={{ top, left }}
      role="toolbar"
      aria-label="Writey's ink"
    >
      {view.writing ? (
        <>
          <span className="ghost-status">
            <span className="thinking-dot" aria-hidden="true" />
            Writing…
          </span>
          <button type="button" onClick={() => ctl.ghostAction('skip')}>
            Show all
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="primary"
            onClick={() => ctl.ghostAction('accept')}
            title="Keep it (Enter)"
          >
            Accept
          </button>
          <button type="button" onClick={() => ctl.ghostAction('redo')} title="Write it again">
            Redo
          </button>
          <button
            type="button"
            onClick={() => ctl.ghostAction('discard')}
            title="Throw it away (Esc)"
          >
            Discard
          </button>
          <button type="button" onClick={() => ctl.ghostAction('why')} title="Explain in the chat">
            Why?
          </button>
        </>
      )}
    </div>
  )
}

function TextEditor({
  edit,
  scale,
  onDone,
}: {
  edit: TextEdit
  scale: number
  onDone(text: string): void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)

  const autoSize = () => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }

  useLayoutEffect(() => {
    autoSize()
    ref.current?.focus()
  })

  const finish = () => {
    if (done.current) return
    done.current = true
    onDone(ref.current?.value ?? '')
  }

  return (
    <textarea
      ref={ref}
      className="text-editor"
      defaultValue={edit.text}
      onInput={autoSize}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Escape') ref.current?.blur()
      }}
      style={{
        left: edit.x * scale,
        top: edit.y * scale,
        width: edit.w * scale,
        fontSize: edit.size * scale,
        color: edit.color,
      }}
    />
  )
}
