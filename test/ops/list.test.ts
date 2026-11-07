import { expect, it } from 'vitest'
import { exec, fixture } from './helpers.js'

const S = '732b68254b3cb32a689fb9f189872fef2bca6434'

it('pulls: one PR reads state, heads and mergeable from the recorded response', async () => {
  const r = await exec(
    'pulls',
    { pr: '1' },
    { 'GET /repos/o/r/pulls/1': { status: 200, body: fixture('pull-1.json') } }
  )
  expect(r.code).toBe(0)
  expect(r.verdict.pull.number).toBe(1)
  expect(r.verdict.pull.head_ref).toBe('v1-initial')
  expect(r.verdict.pull.base_ref).toBe('main')
  expect(r.verdict.pull.head_sha).toMatch(/^[0-9a-f]{40}$/)
  expect(Array.isArray(r.verdict.pull.labels)).toBeTruthy()
})

it('pulls: list, 404 is absent, 403 is unreadable', async () => {
  const l = await exec(
    'pulls',
    { base: 'main' },
    {
      'GET /repos/o/r/pulls?state=open&base=main&per_page=100&page=1': { status: 200, body: fixture('pulls-open.json') }
    }
  )
  expect(l.verdict.pulls.length).toBe(fixture('pulls-open.json').length)
  const gone = await exec('pulls', { pr: '99999' }, { 'GET /repos/o/r/pulls/99999': { status: 404, body: {} } })
  expect(gone.verdict.verdict).toBe('absent')
  const denied = await exec('pulls', { pr: '1' }, { 'GET /repos/o/r/pulls/1': { status: 403, body: { message: 'x' } } })
  expect(denied.code).toBe(1)
})

it('pulls: more pages than allowed is unreadable, not a silent cut', async () => {
  const full = Array.from({ length: 100 }, (_, n) => ({ ...fixture('pulls-open.json')[0], number: n }))
  const routes: Record<string, { status: number; body: unknown }> = {}
  for (const p of [1, 2]) routes[`GET /repos/o/r/pulls?state=open&per_page=100&page=${p}`] = { status: 200, body: full }
  const r = await exec('pulls', { 'max-pages': '2' }, routes)
  expect(r.code).toBe(1)
  expect(r.log).toMatch(/more than 2 pages/)
})

it('runs: filters by sha and reduces the recorded response', async () => {
  const body = fixture('runs.json')
  const r = await exec(
    'runs',
    { workflow: 'ci.yml', sha: S, event: 'pull_request' },
    {
      [`GET /repos/o/r/actions/workflows/ci.yml/runs?head_sha=${S}&event=pull_request&per_page=100&page=1`]: {
        status: 200,
        body
      }
    }
  )
  expect(r.verdict.runs.length).toBe(3)
  expect(Object.keys(r.verdict.runs[0]).sort()).toEqual([
    'actor',
    'attempt',
    'conclusion',
    'created_at',
    'event',
    'head_branch',
    'head_sha',
    'id',
    'status'
  ])
})

it('runners: counts online, busy and idle per label from the org list', async () => {
  const r = await exec(
    'runners',
    { labels: 'crusible-host,crusible-ci-k8s,none' },
    { 'GET /orgs/o/actions/runners?per_page=100&page=1': { status: 200, body: fixture('runners-synthetic.json') } }
  )
  expect(r.verdict.total).toBe(4)
  expect(r.verdict.online).toBe(3)
  expect(r.verdict.by_label['crusible-host']).toEqual({ total: 3, online: 2, busy: 1, idle: 1 })
  expect(r.verdict.by_label['crusible-ci-k8s']).toEqual({ total: 1, online: 1, busy: 0, idle: 1 })
  expect(r.verdict.by_label.none.total).toBe(0)
  const repo = await exec(
    'runners',
    { scope: 'repo' },
    { 'GET /repos/o/r/actions/runners?per_page=100&page=1': { status: 200, body: { runners: [] } } }
  )
  expect(repo.verdict.total).toBe(0)
})

it('runners: administration read missing (403) fails closed', async () => {
  const r = await exec(
    'runners',
    {},
    {
      'GET /orgs/o/actions/runners?per_page=100&page=1': {
        status: 403,
        body: { message: 'Resource not accessible by integration' }
      }
    }
  )
  expect(r.code).toBe(1)
  expect(r.verdict.verdict).toBe('unreadable')
})
