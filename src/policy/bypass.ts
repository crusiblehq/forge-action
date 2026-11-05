// Pure. `,` separates entries (OR); `+` joins labels inside an entry (AND). Exact, case-sensitive.
import { PolicyError } from './modes.js'

export type BypassRules = string[][]

/** A malformed entry (`a+`, `a++b`, `+a`) throws: it would otherwise broaden a rule on a security knob. */
export function parseBypassLabels(raw: string | undefined): BypassRules {
  const rules: BypassRules = []
  for (const entry of (raw ?? '').split(',')) {
    if (entry.trim() === '') continue
    const parts = entry.split('+').map((l) => l.trim())
    if (parts.some((l) => l === '')) {
      throw new PolicyError(`bypass-labels: malformed entry "${entry.trim()}" (empty label around "+")`)
    }
    rules.push(parts)
  }
  return rules
}

/** The first entry whose labels are all present, as written, or null. */
export function bypassMatch(labels: readonly string[], rules: BypassRules): string | null {
  const hit = rules.find((all) => all.every((l) => labels.includes(l)))
  return hit ? hit.join('+') : null
}

export const isPrivileged = (labels: readonly string[], rules: BypassRules): boolean =>
  bypassMatch(labels, rules) !== null
