// Orchestration: inputs + event payload + Gh in, decision out. No Actions-runtime imports, so tests drive it directly.
import {
  addLabel,
  branchTip,
  dispatch,
  hasRunForSha,
  isPermissionError,
  isRateLimit,
  labelNames,
  listReady,
  removeLabel,
  type Gh,
  type Repo
} from './github.js'
import {
  PolicyError,
  admit,
  bypassMatch,
  capPlan,
  decide,
  isMode,
  parseBypassLabels,
  parseEnabledModes,
  parseLimitByLabel,
  resolveMode,
  type Decision,
  type Mode
} from './policy/index.js'

export interface Inputs {
  mode: string
  enabledModes: string
  bypassLabels: string
  limitByLabel: string
  workflow: string
  ref: string
  dispatchInputs: string
  prInput: string
  failfastInput: string
  runsOnInput: string
  failfastModes: string
  runsOnDefault: string
  runsOnOverflow: string
  onCountError: string
  heldLabel: string
  dedupe: boolean
  dryRun: boolean
}

export interface PullRequestPayload {
  number: number
  state?: string
  draft?: boolean
  labels?: Array<string | { name?: string }>
  head: { ref: string; sha: string; repo?: { full_name?: string } | null }
  base: { repo?: { full_name?: string } | null }
}

export interface Result {
  decision: Decision
  reason: string
  mode: Mode
  bucket: string
  count: number
  cap: number
  privileged: boolean
  dispatched: boolean
  failfast: boolean
  runsOn: string
  rank: number
  headSha: string
  heldLabel: string
}

export interface Deps {
  gh: Gh
  repo: Repo
  pr: PullRequestPayload
  inputs: Inputs
  warn(msg: string): void
  info(msg: string): void
  sleep(ms: number): Promise<void>
}

const RETRY_MS = [1000, 3000]

/** Read the count, retrying twice on a transient error or rate limit; a permission refusal fails loudly at once. */
async function readCount(d: Deps, label: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await listReady(d.gh, d.repo, label)
    } catch (err) {
      if (!isRateLimit(err) && isPermissionError(err)) {
        const s = (err as { status?: number }).status
        throw new PolicyError(
          `cap count refused${s ? ` (HTTP ${s})` : ''}: grant the job "pull-requests: read" (and "actions: write", "contents: read") in permissions`
        )
      }
      const wait = RETRY_MS[attempt]
      if (wait === undefined) throw err
      d.warn(`cap count failed (${(err as Error).message}); retrying in ${wait} ms`)
      await d.sleep(wait)
    }
  }
}

/** The branch tip, retrying twice on a rate limit; undefined when still limited. Other errors propagate. */
async function readTip(d: Deps, branch: string): Promise<string | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await branchTip(d.gh, d.repo, branch)
    } catch (err) {
      if (!isRateLimit(err)) throw err
      const wait = RETRY_MS[attempt]
      if (wait === undefined) return undefined
      d.warn(`branch read rate limited; retrying in ${wait} ms`)
      await d.sleep(wait)
    }
  }
}

export async function run(d: Deps): Promise<Result> {
  const { inputs: i, pr } = d
  const enabled = parseEnabledModes(i.enabledModes)
  const resolved = resolveMode(i.mode, enabled)
  resolved.warnings.forEach((w) => d.warn(w))
  const mode = resolved.mode
  const rules = parseBypassLabels(i.bypassLabels)
  const caps = parseLimitByLabel(i.limitByLabel)
  const failfastModes = i.failfastModes
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
  const badFf = failfastModes.filter((m) => !isMode(m))
  if (badFf.length > 0) throw new PolicyError(`failfast-modes: unknown mode ${badFf.join(', ')}`)
  if (i.onCountError !== 'hold' && i.onCountError !== 'dispatch')
    throw new PolicyError('on-count-error: must be "hold" or "dispatch"')
  if (i.workflow.trim() === '') throw new PolicyError('workflow: required')
  let extra: Record<string, string> = {}
  if (i.dispatchInputs.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(i.dispatchInputs)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
      extra = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]))
    } catch (err) {
      throw new PolicyError(`dispatch-inputs: ${(err as Error).message}`)
    }
  }

  const labels = labelNames(pr.labels ?? [])
  const hit = bypassMatch(labels, rules)
  const privileged = hit !== null
  const fork = !pr.head.repo || pr.head.repo.full_name !== pr.base.repo?.full_name
  const base = decide({
    mode,
    draft: pr.draft === true,
    fork,
    open: (pr.state ?? 'open') === 'open',
    privileged,
    failfastModes: failfastModes as Mode[]
  })
  const runsOn = JSON.stringify(mode === 'DEAD_SLOW' && i.runsOnOverflow ? i.runsOnOverflow : i.runsOnDefault)
  const out: Result = {
    decision: base.decision,
    reason: base.reason,
    mode,
    bucket: '',
    count: 0,
    cap: -1,
    privileged,
    dispatched: false,
    failfast: base.failfast,
    runsOn,
    rank: 0,
    headSha: pr.head.sha,
    heldLabel: ''
  }
  if (privileged && base.decision === 'dispatch') out.reason += `; bypass ${hit}: caps do not bind it`
  const hold = (reason: string) => {
    out.decision = 'hold'
    out.reason = reason
    out.failfast = false
  }

  // Dedupe before the cap: a PR already running is never held or re-ranked.
  if (out.decision === 'dispatch' && i.dedupe && (await hasRunForSha(d.gh, d.repo, i.workflow, pr.head.sha))) {
    out.decision = 'skip'
    out.reason = `${i.workflow} already has a run for ${pr.head.sha.slice(0, 7)}`
  }

  // Caps: privileged PRs sit outside them. One GraphQL read per bucket; any bucket full holds.
  const plan = out.decision === 'dispatch' && !privileged ? capPlan(caps, labels, mode) : null
  if (plan) {
    for (const bucket of plan.buckets) {
      let verdict
      try {
        const prs = await readCount(d, bucket)
        const others = prs.filter((p) => p.number !== pr.number && bypassMatch(p.labels, rules) === null)
        verdict = admit(
          others.map((p) => p.number),
          pr.number,
          plan.cap
        )
      } catch (err) {
        if (err instanceof PolicyError) throw err
        out.bucket = bucket
        out.cap = plan.cap
        if (i.onCountError === 'hold') {
          hold(`cap-read-failed: could not count "${bucket}" (${(err as Error).message}); held fail-safe`)
          break
        }
        d.warn(`cap-read-failed for "${bucket}": dispatching per on-count-error=dispatch`)
        continue
      }
      out.bucket = bucket
      out.cap = plan.cap
      out.count = verdict.count
      out.rank = verdict.rank
      if (!verdict.admitted) {
        hold(
          `cap: ${bucket} has ${verdict.count} ready (cap ${plan.cap}, rank ${verdict.rank}); first ${plan.cap}: ${verdict.first.map((n) => `#${n}`).join(' ')}`
        )
        break
      }
    }
  }

  if (out.decision === 'dispatch') {
    // The moved-head check is on the PR's own head branch; `ref` is only the dispatch target.
    const tip = await readTip(d, pr.head.ref)
    if (tip === undefined) {
      out.decision = 'hold'
      out.reason = 'tip-read-failed: branch read rate limited after retries; the next event re-evaluates'
    } else if (tip !== pr.head.sha) {
      out.decision = 'skip'
      out.reason = `branch moved to ${tip.slice(0, 7)} after ${pr.head.sha.slice(0, 7)}; the newer push dispatches its own run`
    } else if (!i.dryRun) {
      const inputs: Record<string, string> = { ...extra }
      if (i.prInput) inputs[i.prInput] = String(pr.number)
      if (i.failfastInput) inputs[i.failfastInput] = String(out.failfast)
      if (i.runsOnInput && runsOn !== '""') inputs[i.runsOnInput] = runsOn
      await dispatch(d.gh, d.repo, i.workflow, i.ref || pr.head.ref, inputs)
      out.dispatched = true
    }
  }

  // Held-label: add on hold, remove on dispatch. Off by default (no label write).
  if (i.heldLabel && !i.dryRun) {
    if (out.decision === 'hold') {
      await addLabel(d.gh, d.repo, pr.number, i.heldLabel)
      out.heldLabel = i.heldLabel
    } else if (out.dispatched && labels.includes(i.heldLabel)) {
      await removeLabel(d.gh, d.repo, pr.number, i.heldLabel)
    }
  }
  return out
}

/** Markdown rows for the job summary. */
export function summaryRows(r: Result, prNumber: number, dryRun: boolean): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Pull request', `#${prNumber} @ ${r.headSha.slice(0, 7)}`],
    ['Mode', r.mode],
    ['Decision', `${r.decision}${r.dispatched ? ' (dispatched)' : dryRun ? ' (dry run)' : ''}`],
    ['Reason', r.reason],
    ['Privileged', String(r.privileged)]
  ]
  if (r.bucket) rows.push(['Bucket', r.bucket], ['Ready / cap / rank', `${r.count} / ${r.cap} / ${r.rank}`])
  if (r.heldLabel) rows.push(['Held label', r.heldLabel])
  return rows
}
