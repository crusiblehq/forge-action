// Pure. `limit-by-label`: a JSON array of { label, modes } read from a repo variable.
import { MODES, PolicyError, isMode, type Mode } from './modes.js'

export interface CapRule {
  label: string
  modes: Partial<Record<Mode, number>>
}

export function parseLimitByLabel(raw: string | undefined): CapRule[] {
  const text = (raw ?? '').trim()
  if (text === '') return []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new PolicyError(`limit-by-label: not valid JSON (${(err as Error).message})`)
  }
  if (!Array.isArray(data)) throw new PolicyError('limit-by-label: must be a JSON array')
  const seen = new Set<string>()
  return data.map((entry: unknown, i) => {
    const at = `limit-by-label[${i}]`
    if (typeof entry !== 'object' || entry === null) throw new PolicyError(`${at}: must be an object`)
    const { label, modes } = entry as { label?: unknown; modes?: unknown }
    if (typeof label !== 'string' || label.trim() === '')
      throw new PolicyError(`${at}.label: must be a non-empty string`)
    if (seen.has(label)) throw new PolicyError(`${at}.label: duplicate pattern "${label}"`)
    seen.add(label)
    if (typeof modes !== 'object' || modes === null || Array.isArray(modes))
      throw new PolicyError(`${at}.modes: must be an object`)
    const out: Partial<Record<Mode, number>> = {}
    for (const [k, v] of Object.entries(modes)) {
      if (!isMode(k)) throw new PolicyError(`${at}.modes: unknown mode "${k}" (expected one of ${MODES.join(', ')})`)
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
        throw new PolicyError(`${at}.modes.${k}: must be an integer >= 0`)
      out[k] = v
    }
    return { label, modes: out }
  })
}

/** Anchored, case-sensitive glob where `*` is any run of characters (including none). */
export function globMatch(pattern: string, value: string): boolean {
  const re = pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${re.join('.*')}$`).test(value)
}

export interface CapPlan {
  rule: CapRule
  cap: number
  /** Actual label values that match the rule: each is its own bucket. */
  buckets: string[]
}

/** First rule (in order) matching any label wins; null if the rule has no cap for `mode` (uncapped) or nothing matches. */
export function capPlan(rules: readonly CapRule[], labels: readonly string[], mode: Mode): CapPlan | null {
  for (const rule of rules) {
    const buckets = labels.filter((l) => globMatch(rule.label, l))
    if (buckets.length === 0) continue
    const cap = rule.modes[mode]
    return cap === undefined ? null : { rule, cap, buckets }
  }
  return null
}

/** Rank by PR number ascending among `ready` (self is included even if absent). Admitted when rank <= cap. */
export function admit(
  ready: readonly number[],
  self: number,
  cap: number
): { admitted: boolean; rank: number; count: number; first: number[] } {
  const all = [...new Set([...ready, self])].sort((a, b) => a - b)
  const rank = all.indexOf(self) + 1
  return { admitted: rank <= cap, rank, count: all.length, first: all.slice(0, cap) }
}
