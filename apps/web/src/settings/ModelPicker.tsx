import { type ModelInfo, PROVIDER_LABEL, RECOMMENDED } from '@writey/ai-core'
import type { AiProvider } from '@writey/shared'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { CheckIcon, DownIcon, SearchIcon } from '../notebook/icons'
import { ProviderMark } from './ProviderMark'

type Props = {
  provider: AiProvider
  model: string
  models: ModelInfo[] | null
  error: string | null
  onPick(id: string): void
}

type Row =
  | { kind: 'group'; label: string; legend?: boolean }
  | { kind: 'model'; model: ModelInfo; index: number }

/** Dollars per million tokens, input · output: "$0.15 · $0.6". */
function price(m: ModelInfo): string | null {
  if (!m.price) return null
  const { input, output } = m.price
  if (input === 0 && output === 0) return 'free'
  const f = (n: number) => `$${Number(n.toPrecision(2))}`
  return `${f(input)} · ${f(output)}`
}

/** A button showing the current model; it opens a searchable list, recommended picks first. */
export function ModelPicker({ provider, model, models, error, onPick }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const current = models?.find((m) => m.id === model)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = (models ?? []).filter(
      (m) => !q || `${m.vendor} ${m.name} ${m.id}`.toLowerCase().includes(q),
    )
    const picks = q
      ? []
      : RECOMMENDED[provider]
          .map((id) => all.find((m) => m.id === id))
          .filter((m): m is ModelInfo => Boolean(m))
    const out: Row[] = []
    let index = 0
    const push = (m: ModelInfo) => out.push({ kind: 'model', model: m, index: index++ })
    if (picks.length) {
      out.push({ kind: 'group', label: 'Recommended' })
      picks.forEach(push)
    }
    const grouped = provider !== 'chatgpt'
    let vendor = ''
    for (const m of all) {
      if (picks.includes(m)) continue
      if (grouped && m.vendor !== vendor) {
        vendor = m.vendor
        out.push({ kind: 'group', label: vendor })
      } else if (!grouped && !out.length) {
        out.push({ kind: 'group', label: 'Your plan’s models' })
      }
      push(m)
    }
    // Prices are per million tokens; say so once, at the top.
    const first = out[0]
    if (first?.kind === 'group' && (models ?? []).some((m) => m.price)) first.legend = true
    return out
  }, [models, query, provider])
  const choices = rows.flatMap((r) => (r.kind === 'model' ? [r.model] : []))

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  // Open on the current model.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when opening
  useEffect(() => {
    if (!open) return
    setQuery('')
    const i = choices.findIndex((m) => m.id === model)
    setActive(Math.max(0, i))
    requestAnimationFrame(() => {
      list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' })
      list.current?.parentElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }, [open])

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (m: ModelInfo | undefined) => {
    if (!m?.supported) return
    onPick(m.id)
    setOpen(false)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') setActive((a) => Math.min(choices.length - 1, a + 1))
    else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1))
    else if (e.key === 'Enter') pick(choices[active])
    else if (e.key === 'Escape') {
      // Close the list, not the whole settings sheet.
      e.stopPropagation()
      setOpen(false)
    } else return
    e.preventDefault()
  }

  const label = current?.name ?? (model || 'Choose a model')
  const sub = current
    ? [
        PROVIDER_LABEL[provider],
        current.vendor !== 'OpenAI' || provider !== 'chatgpt' ? current.vendor : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : models
      ? PROVIDER_LABEL[provider]
      : 'Loading models…'

  return (
    <div className="model-picker" ref={root}>
      <button
        type="button"
        className="model-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <ProviderMark provider={provider} />
        <span className="model-main">
          <strong>{label}</strong>
          <span>{sub}</span>
        </span>
        {current?.vision === false && <span className="tag warn">Can’t see images</span>}
        <DownIcon size={16} />
      </button>

      {open && (
        // biome-ignore lint/a11y/noStaticElementInteractions: keys go to the search box inside
        <div className="model-pop" onKeyDown={onKey}>
          <label className="model-search">
            <SearchIcon size={16} />
            <input
              // biome-ignore lint/a11y/noAutofocus: the list was just opened to search it
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              placeholder={`Search ${models?.length ?? ''} models`}
              aria-label="Search models"
              aria-controls={listId}
              aria-activedescendant={choices[active] ? `${listId}-${active}` : undefined}
            />
          </label>
          <div className="model-list" role="listbox" id={listId} ref={list} aria-label="Models">
            {error && <p className="model-empty">Couldn’t load models. {error}</p>}
            {!models && !error && (
              <>
                <div className="model-skeleton" />
                <div className="model-skeleton" />
                <div className="model-skeleton" />
              </>
            )}
            {models && !choices.length && <p className="model-empty">No models match “{query}”.</p>}
            {rows.map((r) =>
              r.kind === 'group' ? (
                <p key={`g-${r.label}`} className="model-group">
                  <span>{r.label}</span>
                  {r.legend && <span>$ per 1M tokens, in · out</span>}
                </p>
              ) : (
                <button
                  type="button"
                  role="option"
                  key={r.model.id}
                  id={`${listId}-${r.index}`}
                  data-index={r.index}
                  aria-selected={r.model.id === model}
                  className={`model-option${r.index === active ? ' active' : ''}`}
                  disabled={!r.model.supported}
                  tabIndex={-1}
                  onMouseMove={() => setActive(r.index)}
                  onClick={() => pick(r.model)}
                  title={r.model.note ?? r.model.id}
                >
                  <span className="model-option-text">
                    <strong>{r.model.name}</strong>
                    <span>{r.model.note ?? r.model.id}</span>
                  </span>
                  <span className="model-option-meta">
                    {r.model.vision === false && <span className="tag warn">No images</span>}
                    {price(r.model)}
                    {r.model.id === model && <CheckIcon size={16} />}
                  </span>
                </button>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  )
}
