// Pure. Mode ladder -> decision. Caps are applied afterwards by the caller, only on a `dispatch`.
import type { Mode } from './modes.js'

export type Decision = 'dispatch' | 'hold' | 'skip'

export interface DecideInput {
  mode: Mode
  draft: boolean
  fork: boolean
  open: boolean
  privileged: boolean
  failfastModes: readonly Mode[]
}

export interface Decided {
  decision: Decision
  reason: string
  failfast: boolean
}

export function decide(i: DecideInput): Decided {
  const failfast = i.failfastModes.includes(i.mode)
  const no = (decision: Decision, reason: string): Decided => ({ decision, reason, failfast: false })
  if (!i.open) return no('skip', 'pull request is not open')
  if (i.draft) return no('skip', 'draft pull requests never dispatch')
  if (i.fork) return no('skip', 'fork pull request: the job token cannot dispatch for it')
  if (i.mode === 'STOP') return no('hold', 'STOP blocks every pull request, bypass labels included')
  if (i.mode === 'STANDBY' && !i.privileged)
    return no('hold', 'STANDBY holds every pull request without a bypass label')
  const how = i.mode === 'STANDBY' ? 'bypass label lets it through STANDBY' : `mode ${i.mode}`
  return { decision: 'dispatch', reason: how, failfast }
}
