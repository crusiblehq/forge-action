import { describe, expect, it, vi } from 'vitest'
import type { Gh } from '../src/github.js'
import { PolicyError } from '../src/policy/index.js'
import { run, summaryRows, type Inputs, type PullRequestPayload } from '../src/run.js'

const LIMITS = JSON.stringify([
  { label: 'pod:crusible-dev-0', modes: { HALF_AHEAD: 10, SLOW_AHEAD: 6, DEAD_SLOW: 3 } },
  { label: 'pod:*', modes: { HALF_AHEAD: 6, SLOW_AHEAD: 3, DEAD_SLOW: 1 } }
])
const SHA = 'a'.repeat(40)

const inputs = (o: Partial<Inputs> = {}): Inputs => ({
  mode: '',
  enabledModes: '',
  bypassLabels: 'pod:crusible-dev-0+priority:urgent',
  limitByLabel: LIMITS,
  workflow: 'ci.yml',
  ref: '',
  dispatchInputs: '{}',
  prInput: 'pr',
  failfastInput: 'failfast',
  runsOnInput: '',
  failfastModes: 'SLOW_AHEAD',
  runsOnDefault: '',
  runsOnOverflow: '',
  onCountError: 'hold',
  heldLabel: '',
  dedupe: true,
  dryRun: false,
  ...o
})
const pr = (o: Partial<PullRequestPayload> = {}): PullRequestPayload => ({
  number: 20,
  state: 'open',
  draft: false,
  labels: [{ name: 'pod:crusible-dev-1' }],
  head: { ref: 'feat', sha: SHA, repo: { full_name: 'o/r' } },
  base: { repo: { full_name: 'o/r' } },
  ...o
})

interface Opts {
  ready?: Array<{ number: number; labels?: string[] }>
  total?: number
  runs?: Array<{ status: string; conclusion: string | null; event: string }>
  tip?: string
  searchError?: unknown
}
function mock(o: Opts = {}) {
  const search = vi.fn(async () => {
    if (o.searchError) throw o.searchError
    const items = (o.ready ?? []).map((r) => ({ number: r.number, labels: (r.labels ?? []).map((name) => ({ name })) }))
    return { data: { total_count: o.total ?? items.length, items } }
  })
  const createWorkflowDispatch = vi.fn<(p: { inputs?: Record<string, string> }) => Promise<unknown>>(async () => ({}))
  const addLabels = vi.fn(async () => ({}))
  const removeLabel = vi.fn(async () => ({}))
  const gh: Gh = {
    rest: {
      search: { issuesAndPullRequests: search },
      actions: {
        listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: o.runs ?? [] } })),
        createWorkflowDispatch
      },
      git: { getRef: vi.fn(async () => ({ data: { object: { sha: o.tip ?? SHA } } })) },
      issues: { addLabels, removeLabel }
    }
  }
  return { gh, search, createWorkflowDispatch, addLabels, removeLabel }
}
const go = (m: ReturnType<typeof mock>, i: Partial<Inputs> = {}, p: Partial<PullRequestPayload> = {}) => {
  const warn = vi.fn()
  return run({
    gh: m.gh,
    repo: { owner: 'o', repo: 'r' },
    pr: pr(p),
    inputs: inputs(i),
    warn,
    info: vi.fn(),
    sleep: async () => {}
  }).then((r) => ({ r, warn }))
}

describe('run: dispatch path', () => {
  it('dispatches in FULL_AHEAD with the pr and failfast inputs and no search', async () => {
    const m = mock()
    const { r } = await go(m)
    expect(r).toMatchObject({ decision: 'dispatch', dispatched: true, mode: 'FULL_AHEAD', failfast: false })
    expect(m.createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      workflow_id: 'ci.yml',
      ref: 'feat',
      inputs: { pr: '20', failfast: 'false' }
    })
    expect(m.search).not.toHaveBeenCalled()
  })
  it('SLOW_AHEAD under the cap dispatches with failfast=true', async () => {
    const m = mock({ ready: [{ number: 20 }, { number: 21 }] })
    const { r } = await go(m, { mode: 'SLOW_AHEAD' })
    expect(r).toMatchObject({
      decision: 'dispatch',
      failfast: true,
      bucket: 'pod:crusible-dev-1',
      cap: 3,
      count: 2,
      rank: 1
    })
    expect(m.search).toHaveBeenCalledTimes(1)
    expect(m.createWorkflowDispatch.mock.calls[0]?.[0].inputs).toMatchObject({ failfast: 'true' })
  })
  it('merges dispatch-inputs and the runner hint, overflow in DEAD_SLOW', async () => {
    const m = mock()
    await go(m, {
      mode: 'DEAD_SLOW',
      limitByLabel: '',
      dispatchInputs: '{"lane":"ci","n":1}',
      runsOnInput: 'runs_on',
      runsOnDefault: 'host',
      runsOnOverflow: 'arc'
    })
    expect(m.createWorkflowDispatch.mock.calls[0]?.[0].inputs).toEqual({
      lane: 'ci',
      n: '1',
      pr: '20',
      failfast: 'false',
      runs_on: '"arc"'
    })
  })
  it('uses an explicit ref, and empty input names are not sent', async () => {
    const m = mock({ tip: SHA })
    await go(m, { ref: 'feat', prInput: '', failfastInput: '' })
    expect(m.createWorkflowDispatch.mock.calls[0]?.[0]).toMatchObject({ ref: 'feat', inputs: {} })
  })
  it('dry-run dispatches and labels nothing', async () => {
    const m = mock()
    const { r } = await go(m, { dryRun: true, heldLabel: 'held' })
    expect(r).toMatchObject({ decision: 'dispatch', dispatched: false })
    expect(m.createWorkflowDispatch).not.toHaveBeenCalled()
  })
  it('skips when the branch moved after the event', async () => {
    const m = mock({ tip: 'b'.repeat(40) })
    const { r } = await go(m)
    expect(r.decision).toBe('skip')
    expect(r.reason).toMatch(/branch moved/)
    expect(m.createWorkflowDispatch).not.toHaveBeenCalled()
  })
})

describe('run: skips and holds', () => {
  it.each([
    ['draft', { draft: true }],
    ['closed', { state: 'closed' }],
    ['fork', { head: { ref: 'f', sha: SHA, repo: { full_name: 'x/r' } } }],
    ['deleted fork', { head: { ref: 'f', sha: SHA, repo: null } }]
  ] as Array<[string, Partial<PullRequestPayload>]>)('skips a %s PR', async (_n, p) => {
    const m = mock()
    const { r } = await go(m, {}, p)
    expect(r.decision).toBe('skip')
    expect(m.createWorkflowDispatch).not.toHaveBeenCalled()
  })
  it('STOP holds everything, even bypass', async () => {
    const m = mock()
    const { r } = await go(
      m,
      { mode: 'STOP' },
      { labels: [{ name: 'pod:crusible-dev-0' }, { name: 'priority:urgent' }] }
    )
    expect(r).toMatchObject({ decision: 'hold', privileged: true })
  })
  it('STANDBY holds, but pod AND urgent passes and skips the cap', async () => {
    const held = await go(mock(), { mode: 'STANDBY' })
    expect(held.r.decision).toBe('hold')
    expect(held.r.reason).toMatch(/STANDBY/)
    const m = mock()
    const { r } = await go(m, { mode: 'STANDBY' }, { labels: ['pod:crusible-dev-0', 'priority:urgent'] })
    expect(r).toMatchObject({ decision: 'dispatch', dispatched: true, privileged: true })
    expect(m.search).not.toHaveBeenCalled()
  })
  it('urgent alone is not enough for our AND rule', async () => {
    const { r } = await go(mock(), { mode: 'STANDBY' }, { labels: ['priority:urgent'] })
    expect(r.decision).toBe('hold')
  })
  it('mode-not-enabled fails safe and warns', async () => {
    const { r, warn } = await go(mock(), { mode: 'HALF_AHEAD', enabledModes: 'FULL_AHEAD,STANDBY' })
    expect(r).toMatchObject({ mode: 'STANDBY', decision: 'hold' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mode-not-enabled'))
  })
  it('dedupe skips a PR that already has a running or green run, but not a failed one', async () => {
    const running = await go(mock({ runs: [{ status: 'in_progress', conclusion: null, event: 'workflow_dispatch' }] }))
    expect(running.r.decision).toBe('skip')
    const green = await go(mock({ runs: [{ status: 'completed', conclusion: 'success', event: 'workflow_dispatch' }] }))
    expect(green.r.decision).toBe('skip')
    const failed = await go(
      mock({ runs: [{ status: 'completed', conclusion: 'failure', event: 'workflow_dispatch' }] })
    )
    expect(failed.r.decision).toBe('dispatch')
    const other = await go(mock({ runs: [{ status: 'in_progress', conclusion: null, event: 'push' }] }))
    expect(other.r.decision).toBe('dispatch')
    const off = await go(mock({ runs: [{ status: 'in_progress', conclusion: null, event: 'workflow_dispatch' }] }), {
      dedupe: false
    })
    expect(off.r.decision).toBe('dispatch')
  })
})

describe('run: caps', () => {
  const ready = (ns: number[]) => ns.map((number) => ({ number }))
  it('holds the highest-numbered PR over the cap and names the first ones', async () => {
    const m = mock({ ready: ready([1, 2, 3, 20]) })
    const { r } = await go(m, { mode: 'SLOW_AHEAD' })
    expect(r).toMatchObject({ decision: 'hold', count: 4, cap: 3, rank: 4, bucket: 'pod:crusible-dev-1' })
    expect(r.reason).toBe('cap: pod:crusible-dev-1 has 4 ready (cap 3, rank 4); first 3: #1 #2 #3')
  })
  it('admits a lower-numbered PR even when later ones fill the bucket', async () => {
    const { r } = await go(mock({ ready: ready([20, 30, 31, 32]) }), { mode: 'SLOW_AHEAD' })
    expect(r.decision).toBe('dispatch')
  })
  it('does not count bypassing PRs', async () => {
    const m = mock({
      ready: [{ number: 1 }, { number: 2 }, { number: 3, labels: ['pod:crusible-dev-0', 'priority:urgent'] }]
    })
    const { r } = await go(
      m,
      { mode: 'SLOW_AHEAD', limitByLabel: '[{"label":"pod:*","modes":{"SLOW_AHEAD":3}}]' },
      { labels: ['pod:crusible-dev-0'], number: 4 }
    )
    expect(r).toMatchObject({ decision: 'dispatch', count: 3, rank: 3 })
  })
  it('holds when any of two buckets is full', async () => {
    const m = mock({ ready: ready([1, 2, 3]) })
    m.search.mockResolvedValueOnce({ data: { total_count: 0, items: [] } })
    const { r } = await go(m, { mode: 'SLOW_AHEAD' }, { labels: ['pod:a', 'pod:b'] })
    expect(r.decision).toBe('hold')
    expect(r.bucket).toBe('pod:b')
    expect(m.search).toHaveBeenCalledTimes(2)
  })
  it('holds when the bucket is past one search page and self is not on it', async () => {
    const { r } = await go(mock({ ready: ready([1, 2]), total: 150 }), { mode: 'SLOW_AHEAD' })
    expect(r.decision).toBe('hold')
  })
  it('FULL_AHEAD is uncapped in our table', async () => {
    const m = mock()
    await go(m, { mode: 'FULL_AHEAD' })
    expect(m.search).not.toHaveBeenCalled()
  })
  it('a PR with no matching label is uncapped', async () => {
    const m = mock()
    const { r } = await go(m, { mode: 'SLOW_AHEAD' }, { labels: [{ name: 'area:web' }] })
    expect(r.decision).toBe('dispatch')
    expect(m.search).not.toHaveBeenCalled()
  })
  it('retries a transient read error twice, then holds fail-safe', async () => {
    const m = mock({ searchError: Object.assign(new Error('boom'), { status: 502 }) })
    const { r, warn } = await go(m, { mode: 'SLOW_AHEAD' })
    expect(m.search).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(r.decision).toBe('hold')
    expect(r.reason).toMatch(/^cap-read-failed/)
    expect(m.createWorkflowDispatch).not.toHaveBeenCalled()
  })
  it('on-count-error=dispatch dispatches with a warning', async () => {
    const m = mock({ searchError: new Error('network') })
    const { r, warn } = await go(m, { mode: 'SLOW_AHEAD', onCountError: 'dispatch' })
    expect(r).toMatchObject({ decision: 'dispatch', dispatched: true })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cap-read-failed'))
  })
  it('a 403 fails the step at once with the fix', async () => {
    const m = mock({ searchError: Object.assign(new Error('Resource not accessible'), { status: 403 }) })
    await expect(go(m, { mode: 'SLOW_AHEAD' })).rejects.toThrow(/pull-requests: read/)
    expect(m.search).toHaveBeenCalledTimes(1)
  })
})

describe('run: held-label and validation', () => {
  it('adds the held label on a hold', async () => {
    const m = mock({ ready: [{ number: 1 }, { number: 2 }, { number: 3 }] })
    const { r } = await go(m, { mode: 'SLOW_AHEAD', heldLabel: 'ci:held' })
    expect(r.heldLabel).toBe('ci:held')
    expect(m.addLabels).toHaveBeenCalledWith({ owner: 'o', repo: 'r', issue_number: 20, labels: ['ci:held'] })
  })
  it('removes the held label on dispatch, tolerating a 404', async () => {
    const m = mock()
    m.removeLabel.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }))
    const { r } = await go(m, { heldLabel: 'ci:held' }, { labels: ['ci:held'] })
    expect(r.dispatched).toBe(true)
    expect(m.removeLabel).toHaveBeenCalled()
  })
  it('rethrows other label errors', async () => {
    const m = mock()
    m.removeLabel.mockRejectedValueOnce(Object.assign(new Error('bad'), { status: 500 }))
    await expect(go(m, { heldLabel: 'ci:held' }, { labels: ['ci:held'] })).rejects.toThrow('bad')
  })
  it('leaves labels alone when held-label is unset', async () => {
    const m = mock({ ready: [{ number: 1 }, { number: 2 }, { number: 3 }] })
    await go(m, { mode: 'SLOW_AHEAD' })
    expect(m.addLabels).not.toHaveBeenCalled()
  })
  it.each([
    [{ workflow: ' ' }, /workflow/],
    [{ onCountError: 'maybe' }, /on-count-error/],
    [{ failfastModes: 'FAST' }, /failfast-modes/],
    [{ dispatchInputs: '[1]' }, /dispatch-inputs/],
    [{ dispatchInputs: '{' }, /dispatch-inputs/],
    [{ limitByLabel: '{' }, /limit-by-label/],
    [{ enabledModes: 'X' }, /enabled-modes/]
  ] as Array<[Partial<Inputs>, RegExp]>)('rejects invalid input %j', async (i, re) => {
    await expect(go(mock(), i)).rejects.toThrow(re)
    await expect(go(mock(), i)).rejects.toBeInstanceOf(PolicyError)
  })
})

describe('summaryRows', () => {
  it('lists mode, decision and the bucket row only when there is one', async () => {
    const { r } = await go(mock({ ready: [{ number: 1 }] }), { mode: 'SLOW_AHEAD' })
    const rows = summaryRows(r, 20, false)
    expect(rows).toContainEqual(['Decision', 'dispatch (dispatched)'])
    expect(rows).toContainEqual(['Ready / cap / rank', '2 / 3 / 2'])
    const plain = summaryRows({ ...r, bucket: '', heldLabel: 'x', dispatched: false }, 20, true)
    expect(plain).toContainEqual(['Decision', 'dispatch (dry run)'])
    expect(plain).toContainEqual(['Held label', 'x'])
    expect(plain.find(([k]) => k === 'Bucket')).toBeUndefined()
  })
})
