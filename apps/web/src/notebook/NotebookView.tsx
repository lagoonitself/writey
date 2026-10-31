import { getCurrentWindow } from '@tauri-apps/api/window'
import type { NotebookRow, PageRow } from '@writey/shared'
import { generateKeyBetween } from 'fractional-indexing'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react'
import type { ChatControl } from '../chat/ChatPanel'
import { onSynced, syncNow } from '../lib/account'
import { uploadAsset } from '../lib/assets'
import {
  A4,
  addPages,
  getNotebook,
  listPages,
  movePage,
  renameNotebook,
  trashPage,
} from '../lib/db'
import { ask, notify } from '../lib/dialogs'
import { isDesktop } from '../lib/native'
import { pdfPageSizes } from '../lib/pdf'
import { navigate } from '../lib/router'
import { onBroadcastMessage } from '../lib/web/broadcast'
import { useRemoteRefresh } from '../lib/web/remoteRefresh'
import { SettingsDialog, type SettingsTab } from '../settings/SettingsDialog'
import { useAiState } from '../settings/useAiState'
import type { VoiceCommand } from '../voice/trigger'
import { useVoice } from '../voice/useVoice'
import { BackIcon, DownIcon, GearIcon, PlusIcon, TrashIcon, UpIcon } from './icons'
import { PageView } from './PageView'
import { Toolbar } from './Toolbar'
import {
  clipboard,
  DEFAULT_TOOLS,
  type PageHandle,
  type SaveState,
  TOOL_KEYS,
  type ToolState,
} from './tools'

// Markdown and KaTeX are sizable, so the chat panel loads on first open.
const ChatPanel = lazy(() => import('../chat/ChatPanel'))

/** CSS pixels per PDF point at 100% zoom. */
const BASE_SCALE = 96 / 72
const MIN_ZOOM = 0.3
const MAX_ZOOM = 4
const TOOLS_KEY = 'writey.tools'
const CHAT_KEY = 'writey.chat'

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

function savedTools(): ToolState {
  try {
    const raw = localStorage.getItem(TOOLS_KEY)
    return raw ? { ...DEFAULT_TOOLS, ...(JSON.parse(raw) as Partial<ToolState>) } : DEFAULT_TOOLS
  } catch {
    return DEFAULT_TOOLS
  }
}

const scrollToPage = (pageId: string) =>
  requestAnimationFrame(() =>
    document
      .getElementById(`page-${pageId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  )

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

export function NotebookView({ id }: { id: string }) {
  const [notebook, setNotebook] = useState<NotebookRow | null>(null)
  const [title, setTitle] = useState('')
  const [pages, setPages] = useState<PageRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [tools, setToolsState] = useState(savedTools)
  const [zoom, setZoomState] = useState(1)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({})
  const [, bumpHistory] = useReducer((n: number) => n + 1, 0)
  const handles = useRef(new Map<string, PageHandle>()).current
  const scrollRef = useRef<HTMLDivElement>(null)
  const zoomAnchor = useRef<number | null>(null)
  const [ai, setAi] = useAiState()
  const [chatOpen, setChatOpenState] = useState(() => localStorage.getItem(CHAT_KEY) === '1')
  const [askSlot, setAskSlot] = useState<HTMLDivElement | null>(null)
  const [chatFocus, bumpChatFocus] = useReducer((n: number) => n + 1, 0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('ai')
  const openSettings = (tab: SettingsTab = 'ai') => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }
  const chatControl = useRef<ChatControl | null>(null)
  const [voiceAsk, setVoiceAsk] = useState<{ id: number; text: string } | null>(null)
  const voiceAskId = useRef(0)

  const setChatOpen = useCallback((open: boolean) => {
    setChatOpenState(open)
    localStorage.setItem(CHAT_KEY, open ? '1' : '0')
  }, [])

  // Talking to Writey (docs §7): a request opens the chat and asks; commands act directly.
  const voice = useVoice({
    request: (text) => {
      setVoiceAsk({ id: ++voiceAskId.current, text })
    },
    command: (c: VoiceCommand) => {
      const withGhost = [...handles.values()].find((h) => h.hasGhost())
      if (c === 'accept') withGhost?.ghostAccept()
      else if (c === 'discard') withGhost?.ghostDiscard()
      else if (c === 'redo') withGhost?.ghostRedo()
      else chatControl.current?.stop()
    },
  })

  const setTools = useCallback((next: ToolState) => {
    setToolsState(next)
    localStorage.setItem(TOOLS_KEY, JSON.stringify(next))
  }, [])

  useEffect(() => {
    let live = true
    Promise.all([getNotebook(id), listPages(id)])
      .then(([nb, rows]) => {
        if (!live) return
        if (!nb) {
          setError('Notebook not found.')
          return
        }
        setNotebook(nb)
        setTitle(nb.title)
        setPages(rows)
        setActiveId(rows[0]?.id ?? null)
        // Fit the widest page to the window on open, up to 100%.
        const width = scrollRef.current?.clientWidth ?? 1000
        const widest = Math.max(A4.width, ...rows.map((r) => r.width))
        setZoomState(clampZoom(Math.min(1, (width - 64) / (widest * BASE_SCALE))))
      })
      .catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [id])

  // Website: pick up changes synced from the desktop app (focus + interval).
  const refreshFromAccount = useCallback(() => {
    if (isDesktop()) return
    getNotebook(id)
      .then((nb) => {
        if (!nb) {
          setError('Notebook not found.')
          return
        }
        setNotebook(nb)
        setTitle(nb.title)
      })
      .catch(() => {})
    listPages(id)
      .then((rows) => {
        setPages(rows)
        for (const row of rows) {
          void handles.get(row.id)?.reloadIfServerVersion(row.version)
        }
      })
      .catch(() => {})
  }, [id, handles])

  useRemoteRefresh(refreshFromAccount)

  // ---- sync: pages and ink changed on another computer, the website or another tab ----
  useEffect(() => {
    if (!isDesktop()) {
      const offBroadcast = onBroadcastMessage((msg) => {
        if (msg.type === 'pages_changed' && msg.notebookId === id) {
          listPages(id)
            .then(setPages)
            .catch(() => {})
        } else if (msg.type === 'page_saved') {
          void handles.get(msg.pageId)?.reloadIfClean()
        }
      })
      return offBroadcast
    }
    const off = onSynced((r) => {
      for (const pageId of r.pages) void handles.get(pageId)?.reloadIfClean()
      if (r.lists_changed) {
        listPages(id)
          .then((rows) => setPages(rows))
          .catch(() => {})
      }
      if (r.conflicts.length) {
        void notify(
          'This page was also changed on another device. Your version is kept as a new page at the end of the notebook.',
          'info',
        )
      }
    })
    const onFocus = () => void syncNow().catch(() => {})
    window.addEventListener('focus', onFocus)
    return () => {
      void off.then((f) => f())
      window.removeEventListener('focus', onFocus)
    }
  }, [id, handles])

  // ---- zoom, anchored on the middle of the viewport ----
  const setZoom = useCallback((next: number) => {
    const el = scrollRef.current
    if (el) zoomAnchor.current = (el.scrollTop + el.clientHeight / 2) / el.scrollHeight
    setZoomState(clampZoom(next))
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-anchors after each zoom change
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && zoomAnchor.current !== null) {
      el.scrollTop = zoomAnchor.current * el.scrollHeight - el.clientHeight / 2
      zoomAnchor.current = null
    }
  }, [zoom])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setZoomState((z) => {
        zoomAnchor.current = (el.scrollTop + el.clientHeight / 2) / el.scrollHeight
        return clampZoom(z * Math.exp(-e.deltaY * 0.0015))
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ---- the page nearest the viewport middle becomes active while scrolling ----
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const mid = el.getBoundingClientRect().top + el.clientHeight / 2
        let best: string | null = null
        let bestDist = Number.POSITIVE_INFINITY
        for (const node of el.querySelectorAll<HTMLElement>('.page')) {
          const r = node.getBoundingClientRect()
          const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0
          if (d < bestDist) {
            bestDist = d
            best = node.id.slice('page-'.length)
          }
        }
        if (best) setActiveId(best)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // ---- saving: flush on hide, warn before closing with unsaved work ----
  const flushAll = useCallback(
    () => Promise.all([...handles.values()].map((h) => h.flush())),
    [handles],
  )

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flushAll()
    }
    const onUnload = (e: BeforeUnloadEvent) => {
      if ([...handles.values()].some((h) => h.isDirty())) {
        void flushAll()
        e.preventDefault()
      }
    }
    document.addEventListener('visibilitychange', onHide)
    // The app window saves before it closes; a browser tab asks first.
    const closing = isDesktop()
      ? getCurrentWindow().onCloseRequested(async () => {
          await flushAll()
        })
      : null
    if (!closing) window.addEventListener('beforeunload', onUnload)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('beforeunload', onUnload)
      void closing?.then((off) => off())
    }
  }, [flushAll, handles])

  const onSaveState = useCallback((pageId: string, s: SaveState) => {
    setSaveStates((prev) => (prev[pageId] === s ? prev : { ...prev, [pageId]: s }))
  }, [])

  // ---- keyboard: tool shortcuts and zoom ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      // Ctrl+K: type to Writey (again from the box: leave it).
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const inBar = e.target instanceof Element && e.target.closest('.askbar')
        if (inBar) (e.target as HTMLElement).blur()
        else bumpChatFocus()
        return
      }
      if (isTyping(e.target)) return
      if (mod && (e.key === '=' || e.key === '+')) setZoom(zoom * 1.2)
      else if (mod && e.key === '-') setZoom(zoom / 1.2)
      else if (mod && e.key === '0') setZoom(1)
      else if (!mod && !e.altKey && TOOL_KEYS[e.key.toLowerCase()]) {
        setTools({ ...tools, tool: TOOL_KEYS[e.key.toLowerCase()] as ToolState['tool'] })
        return
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom, tools, setZoom, setTools])

  // ---- page operations ----
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    try {
      await fn()
    } catch (e) {
      console.error(e)
      void notify(`${label} failed: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const pagesRef = useRef(pages)
  pagesRef.current = pages

  const pageNumber = useCallback(
    (pageId: string) => pagesRef.current.findIndex((p) => p.id === pageId) + 1,
    [],
  )

  // Writey ran out of room: a blank page right after, ready for its ink (docs §5.4).
  const addPageAfter = useCallback(
    async (pageId: string): Promise<PageRow | null> => {
      const list = pagesRef.current
      const idx = list.findIndex((p) => p.id === pageId)
      const from = list[idx]
      if (!from) return null
      const [row] = await addPages(id, from.sort_key, list[idx + 1]?.sort_key ?? null, [
        { width: from.width, height: from.height, background: { kind: 'blank' } },
      ])
      if (!row) return null
      setPages((prev) => {
        const at = prev.findIndex((p) => p.id === pageId) + 1
        return [...prev.slice(0, at), row, ...prev.slice(at)]
      })
      setActiveId(row.id)
      scrollToPage(row.id)
      const deadline = performance.now() + 15_000
      while (performance.now() < deadline) {
        const h = handles.get(row.id)
        if (h?.isLoaded()) return row
        await new Promise((r) => setTimeout(r, 50))
      }
      return null
    },
    [id, handles],
  )

  const insertAfterActive = (rows: PageRow[]) => {
    setPages((prev) => {
      const idx = prev.findIndex((p) => p.id === activeId)
      const at = idx === -1 ? prev.length : idx + 1
      return [...prev.slice(0, at), ...rows, ...prev.slice(at)]
    })
  }

  const neighborKeys = (): [string | null, string | null] => {
    const idx = pages.findIndex((p) => p.id === activeId)
    if (idx === -1) return [pages.at(-1)?.sort_key ?? null, null]
    return [pages[idx]?.sort_key ?? null, pages[idx + 1]?.sort_key ?? null]
  }

  const addPage = () =>
    run('Adding a page', async () => {
      const [after, before] = neighborKeys()
      const rows = await addPages(id, after, before, [{ ...A4, background: { kind: 'blank' } }])
      insertAfterActive(rows)
      const first = rows[0]
      if (first) {
        setActiveId(first.id)
        scrollToPage(first.id)
      }
    })

  const deletePage = async (page: PageRow) => {
    if (pages.length === 1) {
      void notify('A notebook needs at least one page.', 'info')
      return
    }
    if (!(await ask('Delete this page?', { ok: 'Delete' }))) return
    void run('Deleting the page', async () => {
      await trashPage(page.id)
      setPages((prev) => prev.filter((p) => p.id !== page.id))
    })
  }

  const move = (page: PageRow, dir: -1 | 1) => {
    const idx = pages.findIndex((p) => p.id === page.id)
    const target = idx + dir
    if (target < 0 || target >= pages.length) return
    // Moving up lands between target-1 and target; moving down between target and target+1.
    const lo = dir === -1 ? pages[target - 1] : pages[target]
    const hi = dir === -1 ? pages[target] : pages[target + 1]
    const key = generateKeyBetween(lo?.sort_key ?? null, hi?.sort_key ?? null)
    void run('Moving the page', async () => {
      await movePage(page.id, key)
      setPages((prev) =>
        prev
          .map((p) => (p.id === page.id ? { ...p, sort_key: key } : p))
          .sort((a, b) => (a.sort_key < b.sort_key ? -1 : 1)),
      )
    })
  }

  const importPdf = (file: File) =>
    run('Importing the PDF', async () => {
      const bytes = await file.arrayBuffer()
      const sizes = await pdfPageSizes(bytes.slice(0))
      const asset = await uploadAsset(bytes, 'application/pdf', 'pdf', sizes.length)
      const [after, before] = neighborKeys()
      const rows = await addPages(
        id,
        after,
        before,
        sizes.map((s, i) => ({
          ...s,
          background: { kind: 'pdf', assetId: asset.id, pdfPage: i + 1 },
        })),
      )
      insertAfterActive(rows)
      const first = rows[0]
      if (first) {
        setActiveId(first.id)
        scrollToPage(first.id)
      }
    })

  const insertImage = (file: File) =>
    run('Inserting the image', async () => {
      const handle = activeId ? handles.get(activeId) : undefined
      if (!handle) throw new Error('Scroll to a page first')
      const bitmap = await createImageBitmap(file)
      const { width, height } = bitmap
      bitmap.close()
      const asset = await uploadAsset(await file.arrayBuffer(), file.type, 'image')
      // Images come in at 96 dpi: 1 px = 0.75 pt.
      handle.insertImage(asset, width * 0.75, height * 0.75)
    })

  // A picture copied from any website (or a screenshot) pastes onto the page with Ctrl+V,
  // and image files can be dropped on it.
  const insertRef = useRef(insertImage)
  insertRef.current = insertImage
  useEffect(() => {
    const image = (files: FileList | null | undefined) =>
      [...(files ?? [])].find((f) => f.type.startsWith('image/'))
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return
      const file = image(e.clipboardData?.files)
      if (!file) return
      e.preventDefault()
      void insertRef.current(file)
    }
    const onDragOver = (e: DragEvent) => {
      if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      const file = image(e.dataTransfer?.files)
      if (!file) return
      e.preventDefault()
      void insertRef.current(file)
    }
    // Leaving the tab is how something gets copied elsewhere: Ctrl+V should paste that, not
    // an older lasso copy (which takes the key first).
    const forget = () => {
      clipboard.items = []
    }
    window.addEventListener('paste', onPaste)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    window.addEventListener('blur', forget)
    return () => {
      window.removeEventListener('blur', forget)
      window.removeEventListener('paste', onPaste)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  const saveTitle = () => {
    const next = title.trim() || 'Untitled notebook'
    setTitle(next)
    if (notebook && next !== notebook.title) {
      setNotebook({ ...notebook, title: next })
      renameNotebook(notebook.id, next).catch((e: Error) => notify(`Rename failed: ${e.message}`))
    }
  }

  const goBack = async () => {
    await flushAll()
    navigate('/')
  }

  const active = activeId ? handles.get(activeId) : undefined
  const states = Object.values(saveStates)
  const saveKind = busy
    ? 'saving'
    : states.includes('error')
      ? 'error'
      : states.includes('saving') || states.includes('dirty')
        ? 'saving'
        : 'saved'
  const saveLabel =
    busy ?? { error: 'Not saved, retrying…', saving: 'Saving…', saved: 'Saved' }[saveKind]
  const scale = zoom * BASE_SCALE

  if (error) {
    return (
      <main className="centered">
        <p className="error">{error}</p>
        <button type="button" onClick={() => navigate('/')}>
          Back to notebooks
        </button>
      </main>
    )
  }

  return (
    <div className="notebook">
      <header className="notebook-header">
        <button type="button" className="back" onClick={goBack} title="All notebooks">
          <BackIcon size={18} />
          <span>Notebooks</span>
        </button>
        <span className="crumb-sep" aria-hidden="true">
          /
        </span>
        <input
          className="title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          aria-label="Notebook title"
        />
        <span className={`save-state ${saveKind}`} role="status">
          <span className="save-dot" aria-hidden="true" />
          {saveLabel}
        </span>
        <button
          type="button"
          className="ghost icon-btn"
          onClick={() => openSettings()}
          title="Settings"
          aria-label="Settings"
        >
          <GearIcon size={18} />
        </button>
      </header>
      <div className="notebook-body">
        <nav className="page-list" aria-label="Pages">
          {pages.map((p, i) => (
            <div key={p.id} className={`page-list-item${p.id === activeId ? ' on' : ''}`}>
              <button
                type="button"
                className="page-thumb"
                style={{ aspectRatio: `${p.width} / ${p.height}` }}
                onClick={() => {
                  setActiveId(p.id)
                  scrollToPage(p.id)
                }}
                aria-label={`Page ${i + 1}`}
              >
                <span>{i + 1}</span>
                {p.background.kind === 'pdf' && <small>PDF</small>}
              </button>
              <span className="page-list-actions">
                <button
                  type="button"
                  onClick={() => move(p, -1)}
                  disabled={i === 0}
                  title="Move up"
                  aria-label="Move page up"
                >
                  <UpIcon size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => move(p, 1)}
                  disabled={i === pages.length - 1}
                  title="Move down"
                  aria-label="Move page down"
                >
                  <DownIcon size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => deletePage(p)}
                  title="Delete page"
                  aria-label="Delete page"
                >
                  <TrashIcon size={14} />
                </button>
              </span>
            </div>
          ))}
          <button
            type="button"
            className="add-page"
            onClick={addPage}
            disabled={!notebook}
            title="Add a page after this one"
            aria-label="Add page"
          >
            <PlusIcon size={18} />
          </button>
        </nav>
        <div className="desk">
          <Toolbar
            tools={tools}
            onTools={setTools}
            onColor={(c) => active?.recolor(c)}
            canUndo={active?.canUndo() ?? false}
            canRedo={active?.canRedo() ?? false}
            onUndo={() => active?.undo()}
            onRedo={() => active?.redo()}
            onInsertImage={insertImage}
            onImportPdf={importPdf}
            zoom={zoom}
            onZoom={setZoom}
          />
          <div className="ask-slot" ref={setAskSlot} />
          <div className="pages-scroll" ref={scrollRef}>
            <div className="pages">
              {pages.map((p, i) => (
                <PageView
                  key={p.id}
                  page={p}
                  number={i + 1}
                  scale={scale}
                  tools={tools}
                  active={p.id === activeId}
                  handles={handles}
                  onActivate={setActiveId}
                  onHistory={bumpHistory}
                  onSaveState={onSaveState}
                  onRequestTool={(tool) => setTools({ ...tools, tool })}
                />
              ))}
            </div>
          </div>
        </div>
        <Suspense fallback={null}>
          <ChatPanel
            notebookId={id}
            page={pages.find((p) => p.id === activeId) ?? null}
            pageNumber={pageNumber}
            handle={(pageId) => handles.get(pageId)}
            addPageAfter={addPageAfter}
            ai={ai}
            focusKey={chatFocus}
            onSettings={() => openSettings()}
            onVoiceSettings={() => openSettings('voice')}
            open={chatOpen}
            onOpen={setChatOpen}
            slot={askSlot}
            ask={voiceAsk}
            control={chatControl}
            voice={voice}
          />
        </Suspense>
      </div>
      {settingsOpen && (
        <SettingsDialog
          ai={ai}
          onChange={setAi}
          tab={settingsTab}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
