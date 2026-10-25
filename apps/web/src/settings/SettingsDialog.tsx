import { type ModelInfo, PROVIDER_LABEL } from '@writey/ai-core'
import {
  AI_PROVIDERS,
  type AiProvider,
  type AiSettings,
  DEFAULT_AI,
  KEY_PROVIDERS,
  type KeyProvider,
} from '@writey/shared'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  deleteCredential,
  listModels,
  saveAiSettings,
  saveCredential,
  startOpenRouterConnect,
} from '../lib/ai'
import { ApiRequestError } from '../lib/api'
import { chatgptWelcomed } from '../lib/helper'
import { CloseIcon } from '../notebook/icons'
import { ChatgptCard, WelcomeNotice } from './ChatgptCard'
import { type AiState, usable } from './useAiState'

type Props = { ai: AiState; onChange(next: AiState): void; onClose(): void }

const KEY_PAGE: Record<KeyProvider, string> = {
  openrouter: 'https://openrouter.ai/settings/keys',
  'opencode-zen': 'https://opencode.ai/zen',
}

const BLURB: Record<KeyProvider, string> = {
  openrouter: 'Hundreds of models with one account. Writey’s default.',
  'opencode-zen': 'OpenCode’s curated models, billed to your Zen balance.',
}

/** A sensible model when switching to a provider; ChatGPT takes the first one its plan lists. */
const DEFAULT_MODEL: Record<AiProvider, string> = {
  openrouter: DEFAULT_AI.model,
  'opencode-zen': 'deepseek-v4.1-flash',
  chatgpt: '',
}

export function SettingsDialog({ ai, onChange, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])

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
      <div className="settings-body">
        <header className="settings-header">
          <h2 id="settings-title">Settings</h2>
          <button
            type="button"
            className="ghost chat-icon"
            onClick={() => ref.current?.close()}
            aria-label="Close settings"
          >
            <CloseIcon size={18} />
          </button>
        </header>

        <section>
          <h3>AI provider</h3>
          <p className="muted small">
            Writey uses your own account, so you only pay for what you use. Keys are encrypted on
            Writey’s server and only ever sent to that provider.
          </p>
          {KEY_PROVIDERS.map((provider) => (
            <ProviderCard key={provider} provider={provider} ai={ai} onChange={onChange} />
          ))}
          <ChatgptCard ai={ai} onChange={onChange} />
        </section>

        <ModelSection ai={ai} onChange={onChange} />
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

function ProviderCard({
  provider,
  ai,
  onChange,
}: {
  provider: KeyProvider
  ai: AiState
  onChange(next: AiState): void
}) {
  const saved = ai.credentials.find((c) => c.provider === provider)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = PROVIDER_LABEL[provider]

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const info = await saveCredential(provider, key)
      setKey('')
      const credentials = [...ai.credentials.filter((c) => c.provider !== provider), info]
      // First key in: point Writey at it so asking works straight away.
      const settings = usable(ai, ai.settings.provider)
        ? ai.settings
        : { provider, model: DEFAULT_MODEL[provider] }
      if (settings !== ai.settings) await saveAiSettings(settings)
      onChange({ ...ai, settings, credentials })
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

  return (
    <div className={`provider-card${saved ? ' connected' : ''}`}>
      <div className="provider-head">
        <span className="provider-name">{name}</span>
        {saved && <span className="provider-badge">Connected</span>}
      </div>
      <p className="muted small">{BLURB[provider]}</p>
      {saved ? (
        <div className="provider-row">
          <code className="key-mask">••••{saved.last4}</code>
          <span className="muted small">
            added{' '}
            {new Date(saved.created_at).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            })}
          </span>
          <button type="button" className="ghost small-btn" onClick={remove} disabled={busy}>
            Remove
          </button>
        </div>
      ) : (
        <>
          {provider === 'openrouter' && (
            <button
              type="button"
              className="primary connect"
              onClick={() => void startOpenRouterConnect()}
              disabled={busy}
            >
              Connect OpenRouter
            </button>
          )}
          <form
            className="provider-row"
            onSubmit={(e) => {
              e.preventDefault()
              if (key.trim()) void save()
            }}
          >
            <input
              type="password"
              className="key-input"
              placeholder={provider === 'openrouter' ? 'or paste a key' : 'Paste your API key'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-label={`${name} API key`}
            />
            <button type="submit" disabled={busy || !key.trim()}>
              {busy ? 'Checking…' : 'Save'}
            </button>
          </form>
          <a className="small" href={KEY_PAGE[provider]} target="_blank" rel="noopener noreferrer">
            Get a {name} key ↗
          </a>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  )
}

function ModelSection({ ai, onChange }: { ai: AiState; onChange(next: AiState): void }) {
  const { provider, model } = ai.settings
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let live = true
    setModels(null)
    setLoadError(null)
    listModels(provider)
      .then((m) => live && setModels(m))
      .catch((e: Error) => live && setLoadError(e.message))
    return () => {
      live = false
    }
  }, [provider])

  const choose = async (next: AiSettings) => {
    onChange({ ...ai, settings: next })
    setSaved(false)
    try {
      await saveAiSettings(next)
      setSaved(true)
    } catch (e) {
      alert(`Couldn’t save: ${(e as Error).message}`)
    }
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = models ?? []
    return (q ? list.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q)) : list).slice(
      0,
      200,
    )
  }, [models, query])
  const current = models?.find((m) => m.id === model)

  // ChatGPT has no fixed default: take the first model the plan offers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the list arrives
  useEffect(() => {
    const first = models?.find((m) => m.supported)
    if (provider === 'chatgpt' && first && !models?.some((m) => m.id === model)) {
      void choose({ provider, model: first.id })
    }
  }, [models])

  return (
    <section>
      <h3>Model {saved && <span className="saved-tick">Saved</span>}</h3>
      <div className="segmented">
        {AI_PROVIDERS.map((p) => {
          const ready = usable(ai, p)
          return (
            <button
              type="button"
              key={p}
              aria-pressed={provider === p}
              className={provider === p ? 'on' : ''}
              disabled={!ready && provider !== p}
              title={
                ready
                  ? undefined
                  : p === 'chatgpt'
                    ? 'Sign in with ChatGPT first'
                    : `Add a ${PROVIDER_LABEL[p]} key first`
              }
              onClick={() =>
                provider !== p && void choose({ provider: p, model: DEFAULT_MODEL[p] })
              }
            >
              {PROVIDER_LABEL[p]}
            </button>
          )
        })}
      </div>
      <p className="model-current">
        <strong>{current?.name ?? model}</strong>
        {current?.vision === false && <span className="tag warn">can’t see images</span>}
        {model && model === DEFAULT_MODEL[provider] && <span className="tag">default</span>}
        {provider === 'chatgpt' && <span className="tag">Using ChatGPT plan</span>}
      </p>
      <input
        type="search"
        className="model-search"
        placeholder={provider === 'openrouter' ? 'Search vision models…' : 'Search models…'}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search models"
      />
      <div className="model-list" role="listbox" aria-label="Models">
        {loadError && <p className="error small">Couldn’t load models: {loadError}</p>}
        {!models && !loadError && <p className="muted small">Loading models…</p>}
        {shown.map((m) => (
          <button
            type="button"
            role="option"
            key={m.id}
            aria-selected={m.id === model}
            className={`model-option${m.id === model ? ' on' : ''}`}
            disabled={!m.supported}
            onClick={() => void choose({ provider, model: m.id })}
            title={m.note ?? m.id}
          >
            <span className="model-name">{m.name}</span>
            <span className="model-id">{m.note ?? m.id}</span>
          </button>
        ))}
      </div>
      <p className="muted small">
        Writey reads your handwriting from an image, so pick a model that can see images.
      </p>
    </section>
  )
}
