import { CHATGPT_USAGE_URL, PROVIDER_LABEL, type Usage } from '@writey/ai-core'
import type { PageRow } from '@writey/shared'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { askWritey, HelpFailure } from '../help/engine'
import {
  appendMessages,
  createThread,
  deleteThread,
  listThreads,
  loadMessages,
  type StoredMessage,
  type ThreadInfo,
  turnsOf,
} from '../lib/ai'
import { CloseIcon, HistoryIcon, NewChatIcon, TrashIcon } from '../notebook/icons'
import type { PageHandle } from '../notebook/tools'
import { type AiState, usable } from '../settings/useAiState'
import { speakable } from '../voice/speech'
import type { Voice } from '../voice/useVoice'
import { VoiceGuide } from '../voice/VoiceGuide'
import { AskBar } from './AskBar'
import { renderMarkdown } from './markdown'

type Props = {
  notebookId: string
  /** The page Writey looks at: the one you're on. */
  page: PageRow | null
  pageNumber(pageId: string): number
  handle(pageId: string): PageHandle | undefined
  /** Adds a blank page after this one and resolves once it can take ink. */
  addPageAfter(pageId: string): Promise<PageRow | null>
  ai: AiState
  /** Changes whenever the input should take focus (Ctrl+K). */
  focusKey: number
  onSettings(): void
  onVoiceSettings(): void
  /** The conversation shows beside the page; the ask bar is always there. */
  open: boolean
  onOpen(open: boolean): void
  /** Where the ask bar floats (under the pages). */
  slot: HTMLElement | null
  /** A question from outside the text box (voice). Sent once per id. */
  ask: { id: number; text: string } | null
  /** Lets the notebook stop an answer or check whether one is running (voice commands). */
  control: { current: ChatControl | null }
  voice: Voice
}

export type ChatControl = { stop(): void; busy(): boolean }

type Shown = StoredMessage & {
  seen?: string
  stopped?: boolean
  /** What happened to the ink this answer wrote. */
  ink?: 'pending' | 'accepted' | 'discarded'
  settings?: boolean
  link?: { label: string; url: string }
}
type Live = { status: string; seen: string | null; text: string; thinking: boolean }

const MODE_LABEL: Record<string, string> = {
  chat: 'Explained',
  explain: 'Explained on the page',
  write: 'Written on the page',
  check: 'Checked on the page',
  both: 'Written on the page',
}

const INK_OUTCOME: Record<string, string> = {
  accepted: 'Kept on the page',
  discarded: 'Discarded',
}

let tmpId = 0
const tmp = () => `tmp-${++tmpId}`

export default function ChatPanel(p: Props) {
  const { page, ai, notebookId } = p
  const [threads, setThreads] = useState<ThreadInfo[]>([])
  /** The open conversation; null is a new one, created when the first question is sent. */
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Shown[]>([])
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState<Live | null>(null)
  const [input, setInput] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pinned = useRef(true)
  /** A thread made by sending in this panel already has its messages on screen. */
  const madeHere = useRef<string | null>(null)
  const creating = useRef<Promise<string> | null>(null)
  /** Pages showing the last answer's preview, which a new question keeps (accepts). */
  const lastGhosts = useRef<PageHandle[]>([])
  const busy = live !== null

  // The notebook's newest conversation opens by default.
  useEffect(() => {
    let current = true
    setLoading(true)
    listThreads(notebookId)
      .then((list) => {
        if (!current) return
        setThreads(list)
        setThreadId(list[0]?.id ?? null)
        if (!list.length) setLoading(false)
      })
      .catch((e: Error) => {
        console.error('conversations load failed', e)
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [notebookId])

  useEffect(() => {
    if (!threadId) {
      setMessages([])
      return
    }
    if (madeHere.current === threadId) return
    let current = true
    setLoading(true)
    setMessages([])
    loadMessages(threadId)
      .then((m) => current && setMessages(m))
      .catch((e: Error) => current && console.error('conversation load failed', e))
      .finally(() => current && setLoading(false))
    return () => {
      current = false
    }
  }, [threadId])

  // Focus on every Ctrl+K (not on mount, so tool shortcuts keep working).
  useEffect(() => {
    if (p.focusKey) inputRef.current?.focus()
  }, [p.focusKey])

  useEffect(() => () => abort.current?.abort(), [])

  // Stick to the bottom while answers stream in, unless you scrolled up to read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on new content
  useLayoutEffect(() => {
    const el = logRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, live])

  const send = useCallback(
    async (text: string, on: PageRow | null = page, typed = false) => {
      const utterance = text.trim()
      if (!utterance || busy || !on) return
      const handle = p.handle(on.id)
      if (!handle) return
      // Asking on keeps the last answer's ink, so the new one goes below it, like a tutor
      // carrying on down the page. "Scrap that" or Discard still removes it first.
      for (const h of lastGhosts.current) h.ghostAccept()
      const ghosts = new Map<string, PageHandle>()
      lastGhosts.current = []
      setNotice(null)
      // Typed questions show the conversation; spoken ones only when there's something to read.
      if (typed) p.onOpen(true)
      const user: Shown = { id: tmp(), role: 'user', text: utterance }
      const turns = turnsOf(messages)
      setInput('')
      setHistoryOpen(false)
      pinned.current = true
      setMessages((m) => [...m, user])
      let mode: string | undefined
      let state: Live = { status: 'Looking at your work…', seen: null, text: '', thinking: false }
      setLive(state)
      const controller = new AbortController()
      abort.current = controller
      const model = ai.settings.model
      const replyId = tmp()
      const setInk = (ink: Shown['ink']) =>
        setMessages((m) => m.map((x) => (x.id === replyId ? { ...x, ink } : x)))
      // One answer's ink can span pages; keeping or discarding it on one page does all of them.
      const settleAll = (outcome: 'accepted' | 'discarded') => {
        setInk(outcome)
        for (const h of ghosts.values()) {
          if (outcome === 'accepted') h.ghostAccept()
          else h.ghostDiscard()
        }
      }
      const save = async (reply: Omit<StoredMessage, 'id'>) => {
        let id = threadId
        if (!id) {
          // A second question can finish before the first one's conversation exists.
          creating.current ??= createThread(notebookId, utterance).then(
            (made) => {
              madeHere.current = made.id
              setThreads((t) => [made, ...t])
              setThreadId(made.id)
              return made.id
            },
            (e: unknown) => {
              creating.current = null
              throw e
            },
          )
          id = await creating.current
        } else {
          const at = new Date().toISOString()
          setThreads((t) => {
            const me = t.find((x) => x.id === id)
            return me ? [{ ...me, updated_at: at }, ...t.filter((x) => x !== me)] : t
          })
        }
        await appendMessages(id, [user, reply])
      }
      try {
        const result = await askWritey({
          utterance,
          page: on,
          snapshot: { ...handle.snapshot(), transcript: p.voice.transcript() || undefined },
          settings: ai.settings,
          turns,
          signal: controller.signal,
          spoken: p.voice.speaks(),
          nextPage: (after) => p.addPageAfter(after.id),
          pageNumber: (pg) => p.pageNumber(pg.id),
          onUpdate(u) {
            if (u.type === 'status') state = { ...state, status: u.text }
            else if (u.type === 'seen') state = { ...state, seen: u.image }
            else if (u.type === 'thinking') state = { ...state, thinking: true }
            else if (u.type === 'text') state = { ...state, text: state.text + u.text }
            else if (u.type === 'say') {
              p.voice.say(u.text)
              return
            } else if (u.type === 'plan') {
              mode = u.plan.mode
              if (mode !== 'write') p.onOpen(true)
              if (u.plan.status_line) p.voice.say(u.plan.status_line)
              return
            } else if (u.type === 'inkStart') {
              const h = p.handle(u.page.id)
              if (!h) return
              ghosts.set(u.page.id, h)
              lastGhosts.current = [...ghosts.values()]
              h.ghostStart({
                redo: () => void sendRef.current(utterance, on),
                why: () =>
                  void sendRef.current('Why did you write that? Explain it step by step.', on),
                settled: settleAll,
              })
              return
            } else if (u.type === 'ink') {
              ghosts.get(u.page.id)?.ghostAdd(u.written)
              return
            } else return
            setLive(state)
          },
        })
        const reply: Omit<StoredMessage, 'id'> = {
          role: 'assistant',
          text: result.text,
          mode: result.plan.mode,
          model,
          usage: result.usage,
        }
        setMessages((m) => [
          ...m.map((x) => (x.id === user.id ? { ...x, seen: state.seen ?? undefined } : x)),
          {
            ...reply,
            id: replyId,
            ink: [...ghosts.values()].some((h) => h.hasGhost()) ? 'pending' : undefined,
          },
        ])
        // A model that skipped the spoken part: read the start of the chat answer instead.
        if (!result.said)
          p.voice.say(speakable(result.text.replace(/<details[\s\S]*?<\/details>/g, '')))
        p.voice.answered()
        if (mode === 'write' && ghosts.size)
          setNotice(`Written on page ${p.pageNumber(on.id)} · read the explanation`)
        save(reply).catch((e) => console.error('save failed', e))
      } catch (e) {
        const seenOn = (m: Shown[]) =>
          m.map((x) => (x.id === user.id ? { ...x, seen: state.seen ?? undefined } : x))
        if (controller.signal.aborted) {
          if (state.text) {
            const reply: Omit<StoredMessage, 'id'> = { role: 'assistant', text: state.text, model }
            setMessages((m) => [...seenOn(m), { ...reply, id: tmp(), stopped: true }])
            save(reply).catch((err) => console.error('save failed', err))
          } else setMessages(seenOn)
        } else {
          const help =
            e instanceof HelpFailure
              ? e.help
              : { message: `Something went wrong: ${(e as Error).message}`, settings: false }
          console.error(e)
          setMessages((m) => [
            ...seenOn(m),
            {
              id: tmp(),
              role: 'assistant',
              text: help.message,
              error: true,
              settings: help.settings,
              link: help.link,
            },
          ])
        }
      } finally {
        abort.current = null
        for (const h of ghosts.values()) h.ghostEnd()
        setLive(null)
      }
    },
    [
      busy,
      page,
      threadId,
      notebookId,
      messages,
      ai.settings,
      p.handle,
      p.voice,
      p.onOpen,
      p.addPageAfter,
      p.pageNumber,
    ],
  )
  const sendRef = useRef(send)
  sendRef.current = send

  // Voice: questions arrive as `ask`; "stop" goes through `control`.
  useEffect(() => {
    p.control.current = { stop: () => abort.current?.abort(), busy: () => abort.current !== null }
  })
  const asked = useRef(0)
  useEffect(() => {
    const ask = p.ask
    if (!ask || ask.id === asked.current || busy || loading) return
    asked.current = ask.id
    void send(ask.text)
  }, [p.ask, busy, loading, send])

  const startNew = () => {
    if (busy) return
    madeHere.current = null
    creating.current = null
    setThreadId(null)
    setMessages([])
    setLoading(false)
    setHistoryOpen(false)
    inputRef.current?.focus()
  }

  const open = (id: string) => {
    setHistoryOpen(false)
    if (busy || id === threadId) return
    madeHere.current = null
    creating.current = null
    setThreadId(id)
  }

  const remove = async () => {
    if (!threadId || busy) return
    if (!confirm('Delete this conversation with Writey?')) return
    try {
      await deleteThread(threadId)
    } catch (e) {
      alert((e as Error).message)
      return
    }
    const rest = threads.filter((t) => t.id !== threadId)
    setThreads(rest)
    madeHere.current = null
    creating.current = null
    setThreadId(rest[0]?.id ?? null)
    if (!rest.length) setLoading(false)
  }

  const hasKey = usable(ai, ai.settings.provider)
  const modelName = ai.settings.model.split('/').pop() ?? ai.settings.model
  const ask = (text: string) => void send(text, page, true)

  const bar = (
    <AskBar
      voice={p.voice}
      input={input}
      onInput={setInput}
      onSend={ask}
      onStop={() => abort.current?.abort()}
      inputRef={inputRef}
      busy={busy}
      status={live ? (live.thinking && !live.text ? 'Thinking…' : live.status) : null}
      canAsk={!!page}
      conversationOpen={p.open}
      hasConversation={messages.length > 0 || threads.length > 0}
      onConversation={p.onOpen}
      notice={notice}
      onNotice={() => {
        setNotice(null)
        p.onOpen(true)
      }}
      chatgpt={ai.settings.provider === 'chatgpt'}
      onSettings={p.onVoiceSettings}
    />
  )

  return (
    <>
      {p.slot && createPortal(bar, p.slot)}
      {p.open && (
        <aside className="margin" aria-label="Conversation with Writey">
          <header className="margin-head">
            <span className="margin-title">
              Writey
              {page && <small>on page {p.pageNumber(page.id)}</small>}
            </span>
            <button
              type="button"
              className="margin-model"
              onClick={p.onSettings}
              title={`${PROVIDER_LABEL[ai.settings.provider]} · ${ai.settings.model} (change in Settings)`}
            >
              {modelName || PROVIDER_LABEL[ai.settings.provider]}
            </button>
            <span className="margin-actions">
              <button
                type="button"
                className="ghost chat-icon"
                onClick={startNew}
                disabled={busy || (!threadId && !messages.length)}
                title="New conversation"
                aria-label="New conversation"
              >
                <NewChatIcon size={16} />
              </button>
              <button
                type="button"
                className={`ghost chat-icon${historyOpen ? ' on' : ''}`}
                onClick={() => setHistoryOpen((o) => !o)}
                disabled={busy || !threads.length}
                title="Earlier conversations"
                aria-label="Earlier conversations"
                aria-expanded={historyOpen}
              >
                <HistoryIcon size={16} />
              </button>
              <button
                type="button"
                className="ghost chat-icon"
                onClick={remove}
                disabled={busy || !threadId}
                title="Delete this conversation"
                aria-label="Delete conversation"
              >
                <TrashIcon size={16} />
              </button>
              <button
                type="button"
                className="ghost chat-icon"
                onClick={() => p.onOpen(false)}
                title="Hide (Esc)"
                aria-label="Hide the conversation"
              >
                <CloseIcon size={16} />
              </button>
            </span>
            {historyOpen && (
              <div className="chat-history" role="menu">
                <p className="chat-history-label">Conversations in this notebook</p>
                {threads.map((t) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={t.id}
                    className={t.id === threadId ? 'on' : ''}
                    onClick={() => open(t.id)}
                  >
                    <span>{t.title || 'Conversation'}</span>
                    <small>{when(t.updated_at)}</small>
                  </button>
                ))}
              </div>
            )}
          </header>

          <div
            className="margin-log"
            ref={logRef}
            onScroll={(e) => {
              const el = e.currentTarget
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            }}
          >
            {!loading && !messages.length && !live && (
              <div className="chat-empty">
                {hasKey ? (
                  <>
                    <p className="chat-empty-title">Ask about your work.</p>
                    <p className="muted">
                      Writey reads what you wrote last, or whatever you lasso. Try one of these:
                    </p>
                    <VoiceGuide compact onTry={ask} />
                  </>
                ) : (
                  <>
                    <p className="chat-empty-title">Connect your AI first.</p>
                    <p className="muted">
                      Writey thinks with your own account. Continue with ChatGPT, or connect
                      OpenRouter. It takes a minute.
                    </p>
                    <button type="button" className="primary" onClick={p.onSettings}>
                      Connect an account
                    </button>
                  </>
                )}
              </div>
            )}
            {loading && <p className="muted chat-loading">Loading conversation…</p>}
            {messages.map((m, i) => (
              <Message
                key={m.id}
                m={m}
                onSettings={p.onSettings}
                onWrite={
                  i === messages.length - 1 &&
                  !busy &&
                  m.role === 'assistant' &&
                  !m.error &&
                  (m.mode === 'chat' || (m.mode === 'explain' && !m.text.includes('ink-copy')))
                    ? () => void send('Write this on the page')
                    : undefined
                }
              />
            ))}
            {live && <LiveMessage live={live} />}
          </div>
          {ai.settings.provider === 'chatgpt' && (
            <p className="chat-plan">
              Using ChatGPT plan ·{' '}
              <a href={CHATGPT_USAGE_URL} target="_blank" rel="noopener noreferrer">
                Manage usage
              </a>
            </p>
          )}
        </aside>
      )}
    </>
  )
}

function Message({
  m,
  onSettings,
  onWrite,
}: {
  m: Shown
  onSettings(): void
  onWrite?: () => void
}) {
  const html = useMemo(
    () => (m.role === 'assistant' && !m.error ? renderMarkdown(m.text) : ''),
    [m.role, m.error, m.text],
  )
  const [showSeen, setShowSeen] = useState(false)
  if (m.role === 'user') {
    return (
      <div className="msg user">
        <p>{m.text}</p>
        {m.seen && (
          <button type="button" className="seen-toggle" onClick={() => setShowSeen((s) => !s)}>
            {showSeen ? 'Hide' : 'What Writey saw'}
          </button>
        )}
        {m.seen && showSeen && <img className="seen" src={m.seen} alt="What Writey looked at" />}
      </div>
    )
  }
  if (m.error) {
    return (
      <div className="msg error-msg" role="alert">
        <p>{m.text}</p>
        {m.settings && (
          <button type="button" onClick={onSettings}>
            Open settings
          </button>
        )}
        {m.link && (
          <a className="error-link" href={m.link.url} target="_blank" rel="noopener noreferrer">
            {m.link.label}
          </a>
        )}
      </div>
    )
  }
  return (
    <div className="msg assistant">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized in renderMarkdown */}
      <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
      <MessageFooter m={m} />
      {onWrite && (
        <button type="button" className="write-on-page" onClick={onWrite}>
          Write this on the page
        </button>
      )}
    </div>
  )
}

function MessageFooter({ m }: { m: Shown }) {
  const parts: string[] = []
  if (m.stopped) parts.push('Stopped')
  else if (m.ink && INK_OUTCOME[m.ink]) parts.push(INK_OUTCOME[m.ink] as string)
  else if (m.mode && MODE_LABEL[m.mode]) parts.push(MODE_LABEL[m.mode] as string)
  const usage = usageText(m.usage)
  if (usage) parts.push(usage)
  if (!parts.length) return null
  return <p className="msg-meta">{parts.join(' · ')}</p>
}

/** "14:05" today, "Yesterday", or a date. */
function when(iso: string): string {
  const d = new Date(iso)
  const day = (x: Date) => Math.floor((x.getTime() - x.getTimezoneOffset() * 60_000) / 86_400_000)
  const diff = day(new Date()) - day(d)
  if (diff === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (diff === 1) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function usageText(u: Usage | null | undefined): string {
  if (!u) return ''
  const tokens = (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)
  const t = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tokens` : `${tokens} tokens`
  if (!tokens) return ''
  return u.cost ? `${t} · $${u.cost < 0.01 ? u.cost.toFixed(4) : u.cost.toFixed(2)}` : t
}

function LiveMessage({ live }: { live: Live }) {
  const html = useMemo(() => (live.text ? renderMarkdown(live.text) : ''), [live.text])
  return (
    <div className="msg assistant live" aria-live="polite">
      {!live.text && (
        <p className="msg-status">
          <span className="thinking-dot" aria-hidden="true" />
          {live.thinking ? 'Thinking…' : live.status}
        </p>
      )}
      {live.text && (
        <>
          <p className="msg-status small">{live.status}</p>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized in renderMarkdown */}
          <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
        </>
      )}
    </div>
  )
}
