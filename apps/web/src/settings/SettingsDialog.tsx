import { CHATGPT_USAGE_URL, type ModelInfo, PROVIDER_LABEL } from '@writey/ai-core'
import { type AiProvider, type AiSettings, DEFAULT_AI, type KeyProvider } from '@writey/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deleteCredential,
  listModels,
  saveAiSettings,
  saveCredential,
  startOpenRouterConnect,
} from '../lib/ai'
import { ApiRequestError } from '../lib/api'
import { chatgptUsed, chatgptWelcomed } from '../lib/helper'
import { ChevronIcon, CloseIcon } from '../notebook/icons'
import { ChatgptPanel, WelcomeNotice } from './ChatgptCard'
import { ModelPicker } from './ModelPicker'
import { ProviderMark } from './ProviderMark'
import { type AiState, chatgptReturn, usable } from './useAiState'
import { VoiceSection } from './VoiceSection'

export type SettingsTab = 'ai' | 'voice' | 'privacy'

type Props = {
  ai: AiState
  onChange(next: AiState): void
  onClose(): void
  tab?: SettingsTab
}

const TABS: { id: SettingsTab; label: string; sub: string }[] = [
  { id: 'ai', label: 'AI', sub: 'Account and model' },
  { id: 'voice', label: 'Voice', sub: 'Talk to Writey' },
  { id: 'privacy', label: 'Privacy', sub: 'Keys and audio' },
]

/** ChatGPT first: it needs no key, just the plan you already pay for. */
const ORDER: AiProvider[] = ['chatgpt', 'openrouter', 'opencode-zen']

const KEY_PAGE: Record<KeyProvider, string> = {
  openrouter: 'https://openrouter.ai/settings/keys',
  'opencode-zen': 'https://opencode.ai/zen',
}

/** A sensible model when switching to a provider; ChatGPT takes the first one its plan lists. */
const DEFAULT_MODEL: Record<AiProvider, string> = {
  openrouter: DEFAULT_AI.model,
  'opencode-zen': 'deepseek-v4.1-flash',
  chatgpt: '',
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export function SettingsDialog({ ai, onChange, onClose, tab: firstTab = 'ai' }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const [tab, setTab] = useState<SettingsTab>(chatgptReturn ? 'ai' : firstTab)
  const [open, setOpen] = useState<AiProvider | null>(() =>
    chatgptReturn ? 'chatgpt' : usable(ai, ai.settings.provider) ? null : 'chatgpt',
  )
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])

  const choose = useCallback(
    async (next: AiSettings, base: AiState = ai) => {
      onChange({ ...base, settings: next })
      setSaved(false)
      try {
        await saveAiSettings(next)
        setSaved(true)
      } catch (e) {
        console.error('saving AI settings failed', e)
      }
    },
    [ai, onChange],
  )

  const use = (provider: AiProvider, base: AiState = ai) =>
    choose({ provider, model: DEFAULT_MODEL[provider] }, base)

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop clicks land on the dialog itself; Escape is native
    <dialog
      ref={ref}
      className="settings"
      // The nested welcome dialog's close event reaches here too through React; ignore it.
      onClose={(e) => e.target === ref.current && onClose()}
      onClick={(e) => e.target === ref.current && ref.current?.close()}
      aria-labelledby="settings-title"
    >
      <nav className="settings-nav" aria-label="Settings sections">
        <h2 id="settings-title">Settings</h2>
        {TABS.map((t) => (
          <button
            type="button"
            key={t.id}
            className={tab === t.id ? 'on' : ''}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
          >
            <span>{t.label}</span>
            <small>{t.sub}</small>
          </button>
        ))}
      </nav>

      <div className="settings-main">
        <button
          type="button"
          className="ghost icon-btn settings-close"
          onClick={() => ref.current?.close()}
          aria-label="Close settings"
        >
          <CloseIcon size={18} />
        </button>
        <div className="settings-body" key={tab}>
          {tab === 'ai' && (
            <>
              <NowUsing ai={ai} onConnect={() => setOpen('chatgpt')} />
              <section className="settings-section">
                <div className="section-head">
                  <h3>Accounts</h3>
                </div>
                <p className="section-sub">
                  Writey thinks with your own account, so there’s no Writey bill. ChatGPT needs no
                  key; OpenRouter and OpenCode Zen use one.
                </p>
                <div className="providers">
                  {ORDER.map((p) => (
                    <ProviderRow
                      key={p}
                      provider={p}
                      ai={ai}
                      open={open === p}
                      onToggle={() => setOpen(open === p ? null : p)}
                    >
                      {p === 'chatgpt' ? (
                        <>
                          <ChatgptPanel ai={ai} onChange={onChange} />
                          {usable(ai, p) && ai.settings.provider !== p && (
                            <button type="button" className="primary" onClick={() => use(p)}>
                              Use ChatGPT for Writey
                            </button>
                          )}
                        </>
                      ) : (
                        <KeyPanel provider={p} ai={ai} onChange={onChange} onUse={use} />
                      )}
                    </ProviderRow>
                  ))}
                </div>
              </section>
              <ModelSection ai={ai} choose={choose} saved={saved} />
            </>
          )}
          {tab === 'voice' && <VoiceSection />}
          {tab === 'privacy' && (
            <section className="settings-section">
              <h3 className="settings-title">Privacy</h3>
              <ul className="privacy-list">
                <li>
                  <strong>API keys</strong> are encrypted on Writey’s server and only ever sent to
                  that provider. You can remove them any time under AI.
                </li>
                <li>
                  <strong>Your ChatGPT sign-in</strong> never leaves this computer: Writey Helper
                  keeps it.
                </li>
                <li>
                  <strong>Your voice</strong> is turned into text on this computer. No audio is
                  uploaded or stored.
                </li>
                <li>
                  <strong>What Writey sees</strong> is an image of the part of the page you’re
                  working on, sent to the AI you chose when you ask. Every answer has a “What Writey
                  saw” link.
                </li>
              </ul>
            </section>
          )}
        </div>
      </div>

      {ai.chatgpt?.welcome && (
        <WelcomeNotice
          onDone={() => {
            if (ai.chatgpt) onChange({ ...ai, chatgpt: { ...ai.chatgpt, welcome: false } })
            void chatgptWelcomed().catch(() => {})
          }}
        />
      )}
    </dialog>
  )
}

/** What Writey thinks with right now, at a glance. */
function NowUsing({ ai, onConnect }: { ai: AiState; onConnect(): void }) {
  const { provider, model } = ai.settings
  const ready = usable(ai, provider)
  return (
    <div className={`now-using${ready ? ' ready' : ''}`}>
      <ProviderMark provider={provider} />
      <span className="now-using-text">
        <small>Writey thinks with</small>
        <strong>{model ? model.split('/').pop() : PROVIDER_LABEL[provider]}</strong>
        <span>via {PROVIDER_LABEL[provider]}</span>
      </span>
      {ready ? (
        <span className="pill ok">Ready</span>
      ) : (
        <button type="button" className="primary" onClick={onConnect}>
          Connect an account
        </button>
      )}
    </div>
  )
}

function statusOf(ai: AiState, provider: AiProvider): { text: string; ok: boolean } {
  if (provider === 'chatgpt') {
    if (ai.chatgpt?.signed_in && ai.helper === 'ok') {
      return { text: ai.chatgpt.email ?? 'Signed in', ok: Boolean(ai.chatgpt.plan_usage) }
    }
    if (ai.helper === 'outdated') return { text: 'Writey Helper needs an update', ok: false }
    if (ai.helper === 'offline' && chatgptUsed()) {
      return { text: 'Writey Helper isn’t running', ok: false }
    }
    return { text: 'Use your Plus or Pro plan', ok: false }
  }
  const saved = ai.credentials.find((c) => c.provider === provider)
  if (saved) return { text: `Connected · key ••••${saved.last4}`, ok: true }
  return {
    text: provider === 'openrouter' ? 'Hundreds of models, pay as you go' : 'Paste an API key',
    ok: false,
  }
}

function ProviderRow({
  provider,
  ai,
  open,
  onToggle,
  children,
}: {
  provider: AiProvider
  ai: AiState
  open: boolean
  onToggle(): void
  children: React.ReactNode
}) {
  const status = statusOf(ai, provider)
  const inUse = ai.settings.provider === provider && usable(ai, provider)
  const id = `provider-${provider}`
  return (
    <div className={`provider${open ? ' open' : ''}`}>
      <button
        type="button"
        className="provider-row"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={id}
      >
        <ProviderMark provider={provider} />
        <span className="provider-text">
          <span className="provider-name">{PROVIDER_LABEL[provider]}</span>
          <span className={`provider-status${status.ok ? ' ok' : ''}`}>{status.text}</span>
        </span>
        {inUse && <span className="in-use">In use</span>}
        <ChevronIcon size={16} />
      </button>
      {open && (
        <div className="provider-detail" id={id}>
          {children}
        </div>
      )}
    </div>
  )
}

function KeyPanel({
  provider,
  ai,
  onChange,
  onUse,
}: {
  provider: KeyProvider
  ai: AiState
  onChange(next: AiState): void
  onUse(provider: AiProvider, base?: AiState): void
}) {
  const saved = ai.credentials.find((c) => c.provider === provider)
  const [key, setKey] = useState('')
  const [pasting, setPasting] = useState(provider !== 'openrouter')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = PROVIDER_LABEL[provider]

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const info = await saveCredential(provider, key)
      setKey('')
      const next = {
        ...ai,
        credentials: [...ai.credentials.filter((c) => c.provider !== provider), info],
      }
      // First account in: point Writey at it so asking works straight away.
      if (usable(ai, ai.settings.provider)) onChange(next)
      else onUse(provider, next)
    } catch (e) {
      const code = e instanceof ApiRequestError ? e.message : ''
      setError(
        code === 'invalid_key'
          ? `${name} says this key isn’t valid.`
          : code === 'bad_key'
            ? 'That doesn’t look like an API key.'
            : `Couldn’t save the key: ${(e as Error).message}`,
      )
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!confirm(`Remove your ${name} key from Writey?`)) return
    setBusy(true)
    try {
      await deleteCredential(provider)
      onChange({ ...ai, credentials: ai.credentials.filter((c) => c.provider !== provider) })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (saved) {
    return (
      <>
        <div className="key-saved">
          <code>••••{saved.last4}</code>
          <span>added {shortDate(saved.created_at)}</span>
        </div>
        <div className="actions">
          {ai.settings.provider !== provider && (
            <button type="button" className="primary" onClick={() => onUse(provider)}>
              Use {name} for Writey
            </button>
          )}
          <button type="button" className="link-btn" onClick={remove} disabled={busy}>
            Remove key
          </button>
        </div>
        {error && <p className="inline-error">{error}</p>}
      </>
    )
  }

  return (
    <>
      {provider === 'openrouter' ? (
        <p>One account for models from DeepSeek, Google, Anthropic, OpenAI and more.</p>
      ) : (
        <p>OpenCode’s curated models, billed to your Zen balance.</p>
      )}
      {provider === 'openrouter' && (
        <div className="actions">
          <button
            type="button"
            className="primary"
            onClick={() => void startOpenRouterConnect()}
            disabled={busy}
          >
            Connect OpenRouter
          </button>
          {!pasting && (
            <button type="button" className="link-btn" onClick={() => setPasting(true)}>
              Use an API key instead
            </button>
          )}
        </div>
      )}
      {pasting && (
        <form
          className="key-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (key.trim()) void save()
          }}
        >
          <input
            type="password"
            className="field mono"
            placeholder={provider === 'openrouter' ? 'sk-or-…' : 'Your Zen API key'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label={`${name} API key`}
          />
          <button type="submit" disabled={busy || !key.trim()}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {busy ? 'Checking' : 'Save'}
          </button>
        </form>
      )}
      {pasting && (
        <a className="note" href={KEY_PAGE[provider]} target="_blank" rel="noopener noreferrer">
          Get a {name} key ↗
        </a>
      )}
      {error && <p className="inline-error">{error}</p>}
    </>
  )
}

function ModelSection({
  ai,
  choose,
  saved,
}: {
  ai: AiState
  choose(next: AiSettings): Promise<void>
  saved: boolean
}) {
  const { provider, model } = ai.settings
  const ready = usable(ai, provider)
  // Key providers list their models publicly, so you can look before connecting.
  const listable = ready || provider !== 'chatgpt'
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setModels(null)
    setLoadError(null)
    if (!listable) return
    listModels(provider)
      .then((m) => live && setModels(m))
      .catch((e: Error) => live && setLoadError(e.message))
    return () => {
      live = false
    }
  }, [provider, listable])

  // ChatGPT has no fixed default: take the first model the plan offers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the list arrives
  useEffect(() => {
    const first = models?.find((m) => m.supported)
    if (provider === 'chatgpt' && first && !models?.some((m) => m.id === model)) {
      void choose({ provider, model: first.id })
    }
  }, [models])

  return (
    <section className="settings-section">
      <div className="section-head">
        <h3>Model</h3>
        {saved && <span className="saved-tick">Saved</span>}
      </div>
      <p className="section-sub">
        {ready
          ? 'Writey reads your handwriting from an image, so pick one that can see images.'
          : `Connect ${PROVIDER_LABEL[provider]} above to start using it.`}
      </p>
      {listable && (
        <ModelPicker
          provider={provider}
          model={model}
          models={models}
          error={loadError}
          onPick={(id) => void choose({ provider, model: id })}
        />
      )}
      {ready && provider === 'chatgpt' && (
        <p className="plan-line">
          Using ChatGPT plan ·{' '}
          <a href={CHATGPT_USAGE_URL} target="_blank" rel="noopener noreferrer">
            Manage usage
          </a>
        </p>
      )}
    </section>
  )
}
