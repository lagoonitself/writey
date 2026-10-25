import { PROVIDER_LABEL, type Usage } from '@writey/ai-core'
import type { PageRow } from '@writey/shared'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { askWritey, HelpFailure } from '../help/engine'
import { appendMessages, clearThread, loadThread, type StoredMessage, turnsOf } from '../lib/ai'
import { CloseIcon, SendIcon, SparkleIcon, StopIcon, TrashIcon } from '../notebook/icons'
import type { PageHandle } from '../notebook/tools'
import type { AiState } from '../settings/useAiState'
import { renderMarkdown } from './markdown'

type Props = {
  page: PageRow | null
  pageNumber: number
  handle(pageId: string): PageHandle | undefined
  ai: AiState
  /** Changes whenever the input should take focus (Ctrl+K). */
  focusKey: number
  onSettings(): void
  onClose(): void
}

type Shown = StoredMessage & { seen?: string; stopped?: boolean; settings?: boolean }
type Live = { status: string; seen: string | null; text: string; thinking: boolean }

const EXAMPLES = ["What's next?", 'Is this right?', 'Explain the last step', 'Give me a hint']

const MODE_LABEL: Record<string, string> = {
  explain: 'Explained',
  write: 'Worked it out',
  check: 'Checked',
  both: 'Worked it out',
}

let tmpId = 0
const tmp = () => `tmp-${++tmpId}`

export default function ChatPanel(p: Props) {
  const { page, ai } = p
  const [threadPage, setThreadPage] = useState<PageRow | null>(page)
  const [messages, setMessages] = useState<Shown[]>([])
  const [loading, setLoading] = useState(false)
  const [live, setLive] = useState<Live | null>(null)
  const [input, setInput] = useState('')
  const abort = useRef<AbortController | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pinned = useRef(true)
  const busy = live !== null

  // Follow the page you're looking at, but never switch threads mid-answer.
  useEffect(() => {
    if (!busy && page?.id !== threadPage?.id) setThreadPage(page)
  }, [page, busy, threadPage])

  useEffect(() => {
    if (!threadPage) return
    let current = true
    setLoading(true)
    setMessages([])
    loadThread(threadPage.id)
      .then((m) => current && setMessages(m))
      .catch((e: Error) => current && console.error('thread load failed', e))
      .finally(() => current && setLoading(false))
    return () => {
      current = false
    }
  }, [threadPage])

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus on every Ctrl+K
  useEffect(() => inputRef.current?.focus(), [p.focusKey])

  useEffect(() => () => abort.current?.abort(), [])

  // Stick to the bottom while answers stream in, unless you scrolled up to read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on new content
  useLayoutEffect(() => {
    const el = logRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, live])

  const send = useCallback(
    async (text: string) => {
      const utterance = text.trim()
      if (!utterance || busy || !threadPage) return
      const handle = p.handle(threadPage.id)
      if (!handle) return
      const pageId = threadPage.id
      const user: Shown = { id: tmp(), role: 'user', text: utterance }
      const turns = turnsOf(messages)
      setInput('')
      pinned.current = true
      setMessages((m) => [...m, user])
      let state: Live = { status: 'Looking at your work…', seen: null, text: '', thinking: false }
      setLive(state)
      const controller = new AbortController()
      abort.current = controller
      const model = ai.settings.model
      try {
        const result = await askWritey({
          utterance,
          page: threadPage,
          snapshot: handle.snapshot(),
          settings: ai.settings,
          turns,
          signal: controller.signal,
          onUpdate(u) {
            if (u.type === 'status') state = { ...state, status: u.text }
            else if (u.type === 'seen') state = { ...state, seen: u.image }
            else if (u.type === 'thinking') state = { ...state, thinking: true }
            else if (u.type === 'text') state = { ...state, text: state.text + u.text }
            else return
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
          { ...reply, id: tmp() },
        ])
        appendMessages(pageId, [user, reply]).catch((e) => console.error('save failed', e))
      } catch (e) {
        const seenOn = (m: Shown[]) =>
          m.map((x) => (x.id === user.id ? { ...x, seen: state.seen ?? undefined } : x))
        if (controller.signal.aborted) {
          if (state.text) {
            const reply: Omit<StoredMessage, 'id'> = { role: 'assistant', text: state.text, model }
            setMessages((m) => [...seenOn(m), { ...reply, id: tmp(), stopped: true }])
            appendMessages(pageId, [user, reply]).catch((err) => console.error('save failed', err))
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
            },
          ])
        }
      } finally {
        abort.current = null
        setLive(null)
      }
    },
    [busy, threadPage, messages, ai.settings, p.handle],
  )

  const clear = async () => {
    if (!threadPage || busy || !messages.length) return
    if (!confirm('Clear this page’s conversation with Writey?')) return
    await clearThread(threadPage.id).catch((e: Error) => alert(e.message))
    setMessages([])
  }

  const hasKey = ai.credentials.some((c) => c.provider === ai.settings.provider)
  const modelName = ai.settings.model.split('/').pop() ?? ai.settings.model

  return (
    <aside className="chat" aria-label="Ask Writey">
      <header className="chat-header">
        <span className="chat-title">
          <SparkleIcon size={18} />
          Writey
          {threadPage && <small>Page {p.pageNumber}</small>}
        </span>
        <button
          type="button"
          className="chat-model"
          onClick={p.onSettings}
          title={`${PROVIDER_LABEL[ai.settings.provider]} · ${ai.settings.model}`}
        >
          {modelName}
        </button>
        <button
          type="button"
          className="ghost chat-icon"
          onClick={clear}
          disabled={busy || !messages.length}
          title="Clear this page’s conversation"
          aria-label="Clear conversation"
        >
          <TrashIcon size={16} />
        </button>
        <button
          type="button"
          className="ghost chat-icon"
          onClick={p.onClose}
          title="Close (Ctrl+K)"
          aria-label="Close chat"
        >
          <CloseIcon size={16} />
        </button>
      </header>

      <div
        className="chat-log"
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
                  Writey looks at what you wrote last, or at whatever you lasso.
                </p>
                <div className="chat-examples">
                  {EXAMPLES.map((ex) => (
                    <button type="button" key={ex} onClick={() => send(ex)} disabled={!threadPage}>
                      {ex}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <p className="chat-empty-title">Connect an AI first.</p>
                <p className="muted">
                  Writey uses your own {PROVIDER_LABEL[ai.settings.provider]} account. It takes a
                  minute.
                </p>
                <button type="button" className="primary" onClick={p.onSettings}>
                  Open settings
                </button>
              </>
            )}
          </div>
        )}
        {loading && <p className="muted chat-loading">Loading conversation…</p>}
        {messages.map((m) => (
          <Message key={m.id} m={m} onSettings={p.onSettings} />
        ))}
        {live && <LiveMessage live={live} />}
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault()
          void send(input)
        }}
      >
        <textarea
          ref={inputRef}
          value={input}
          rows={1}
          placeholder={threadPage ? 'Ask Writey…' : 'Open a page to ask Writey'}
          disabled={!threadPage}
          onChange={(e) => {
            setInput(e.target.value)
            e.target.style.height = '0px'
            e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send(input)
            } else if (e.key === 'Escape' && !input) p.onClose()
          }}
          aria-label="Message Writey"
        />
        {busy ? (
          <button
            type="button"
            className="chat-send stop"
            onClick={() => abort.current?.abort()}
            title="Stop"
            aria-label="Stop"
          >
            <StopIcon size={18} />
          </button>
        ) : (
          <button
            type="submit"
            className="chat-send"
            disabled={!input.trim() || !threadPage}
            title="Send (Enter)"
            aria-label="Send"
          >
            <SendIcon size={18} />
          </button>
        )}
      </form>
    </aside>
  )
}

function Message({ m, onSettings }: { m: Shown; onSettings(): void }) {
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
      </div>
    )
  }
  return (
    <div className="msg assistant">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized in renderMarkdown */}
      <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
      <MessageFooter m={m} />
    </div>
  )
}

function MessageFooter({ m }: { m: Shown }) {
  const parts: string[] = []
  if (m.stopped) parts.push('Stopped')
  else if (m.mode && MODE_LABEL[m.mode]) parts.push(MODE_LABEL[m.mode] as string)
  const usage = usageText(m.usage)
  if (usage) parts.push(usage)
  if (!parts.length) return null
  return <p className="msg-meta">{parts.join(' · ')}</p>
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
