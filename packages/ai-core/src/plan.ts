import type { Mode, Route, Scope } from './intent'

/** Result of the fast PLAN call (docs §5.3). */
export type Plan = {
  problem: string
  user_progress: string
  mode: Mode
  scope: Scope
  target_line: string | null
  status_line: string
}

const MODES: readonly string[] = ['write', 'explain', 'check', 'both', 'chat']
const SCOPES: readonly string[] = ['hint', 'next_step', 'full']

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/**
 * Reads the PLAN reply. Models don't all support a strict JSON mode, so this takes the
 * first {...} in the text (fenced or not) and fills in anything missing or invalid.
 */
export function parsePlan(text: string): Plan | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  const mode = str(raw.mode)
  const scope = str(raw.scope)
  const target = str(raw.target_line).toUpperCase()
  return {
    problem: str(raw.problem),
    user_progress: str(raw.user_progress),
    mode: (MODES.includes(mode) ? mode : 'explain') as Mode,
    scope: (SCOPES.includes(scope) ? scope : 'next_step') as Scope,
    target_line: /^L\d+$/.test(target) ? target : null,
    status_line: str(raw.status_line).slice(0, 120),
  }
}

/** The wording's rules beat the PLAN call (docs §5.2); a missing plan falls back to chat. */
export function decide(route: Route, plan: Plan | null): Plan {
  const base: Plan = plan ?? {
    problem: '',
    user_progress: '',
    mode: 'explain',
    scope: 'next_step',
    target_line: null,
    status_line: '',
  }
  return { ...base, mode: route.mode ?? base.mode, scope: route.scope ?? base.scope }
}
