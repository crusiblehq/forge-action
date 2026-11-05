// Pure: no I/O. The six modes, most permissive first. Order is the fail-safe ladder.
export const MODES = ['FULL_AHEAD', 'HALF_AHEAD', 'SLOW_AHEAD', 'DEAD_SLOW', 'STANDBY', 'STOP'] as const
export type Mode = (typeof MODES)[number]

export class PolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyError'
  }
}

export const isMode = (v: string): v is Mode => (MODES as readonly string[]).includes(v)

const LEGACY: Record<string, Mode> = { GREEN: 'FULL_AHEAD', YELLOW: 'SLOW_AHEAD' }

export interface ParsedMode {
  mode: Mode
  warnings: string[]
}

/** Unset/empty = FULL_AHEAD. Legacy GREEN/YELLOW map with a warning. Unknown = SLOW_AHEAD with a warning. */
export function parseMode(raw: string | undefined): ParsedMode {
  const v = (raw ?? '').trim()
  if (v === '') return { mode: 'FULL_AHEAD', warnings: [] }
  if (isMode(v)) return { mode: v, warnings: [] }
  const legacy = LEGACY[v]
  if (legacy) return { mode: legacy, warnings: [`legacy-mode-${v}`] }
  return { mode: 'SLOW_AHEAD', warnings: [`mode-value: "${v}" is not a mode, using SLOW_AHEAD`] }
}

/** Comma list of modes. Empty = all six. An unknown token or a list that parses to nothing is an error. */
export function parseEnabledModes(raw: string | undefined): Mode[] {
  const parts = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) return [...MODES]
  const bad = parts.filter((p) => !isMode(p))
  if (bad.length > 0) throw new PolicyError(`enabled-modes: unknown mode ${bad.map((b) => `"${b}"`).join(', ')}`)
  return MODES.filter((m) => parts.includes(m))
}

/**
 * A mode outside `enabled` fails safe: the nearest enabled mode that is MORE restrictive;
 * with none, the most restrictive enabled mode. Never less restrictive than the variable asked for.
 */
export function resolveMode(raw: string | undefined, enabled: readonly Mode[]): ParsedMode {
  const parsed = parseMode(raw)
  if (enabled.includes(parsed.mode)) return parsed
  const idx = MODES.indexOf(parsed.mode)
  const used =
    MODES.slice(idx + 1).find((m) => enabled.includes(m)) ?? [...MODES].reverse().find((m) => enabled.includes(m))!
  return { mode: used, warnings: [...parsed.warnings, `mode-not-enabled: ${parsed.mode} -> ${used}`] }
}
