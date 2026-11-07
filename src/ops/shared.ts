export type OpInputs = Record<string, string | undefined> & { repository: string }
export interface OpDeps {
  sleep(ms: number): Promise<void>
  log(line: string): void
}
export const list = (raw: string): string[] =>
  raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)

/** Strip the token from any text before it reaches a log. */
export const scrub = (text: string, token: string): string => (token ? text.split(token).join('***') : text)

const REPO = /^[\w.-]+\/[\w.-]+$/
const NUM = /^\d+$/
export const SHA = /^[0-9a-f]{40}$/

/** Reject repository and pr values that would be spliced into an API path: they could retarget the token. A sha is checked by the op that puts it in a path. */
export function validate(i: OpInputs): void {
  if (!REPO.test(i.repository) || i.repository.split('/').some((p) => p === '.' || p === '..'))
    throw new Error(`bad repository: ${JSON.stringify(i.repository)}`)
  for (const k of ['pr', 'run', 'attempt', 'max-runs', 'delay-seconds'])
    if (i[k] && !NUM.test(i[k]!)) throw new Error(`bad ${k}: ${JSON.stringify(i[k])}`)
}
