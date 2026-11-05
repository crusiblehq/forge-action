// Pure. `,` separates entries (OR); `+` joins labels inside an entry (AND). Exact, case-sensitive.
export type BypassRules = string[][]

export function parseBypassLabels(raw: string | undefined): BypassRules {
  return (raw ?? '')
    .split(',')
    .map((entry) =>
      entry
        .split('+')
        .map((l) => l.trim())
        .filter(Boolean)
    )
    .filter((all) => all.length > 0)
}

/** The first entry whose labels are all present, as written, or null. */
export function bypassMatch(labels: readonly string[], rules: BypassRules): string | null {
  const hit = rules.find((all) => all.every((l) => labels.includes(l)))
  return hit ? hit.join('+') : null
}

export const isPrivileged = (labels: readonly string[], rules: BypassRules): boolean =>
  bypassMatch(labels, rules) !== null
