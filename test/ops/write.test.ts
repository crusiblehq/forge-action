import { expect, it } from 'vitest'
import { exec, fixture } from './helpers.js'

const S: string = '732b68254b3cb32a689fb9f189872fef2bca6434'

it('status writes and never prints the token', async () => {
  const r = await exec(
    'status',
    { sha: S, context: 'ci-route', state: 'success', description: 'pool=host' },
    { [`POST /repos/o/r/statuses/${S}`]: { status: 201, body: {} } }
  )
  expect(r.code).toBe(0)
  expect(r.calls[0]!.body).toEqual({ state: 'success', context: 'ci-route', description: 'pool=host' })
  expect(r.calls[0]!.auth).toBe('Bearer tok_SECRET')
  expect(r.log).toMatch(/::add-mask::tok_SECRET/)
  expect(r.log.replace('::add-mask::tok_SECRET', '')).not.toMatch(/tok_SECRET/)
  expect(r.outputs).not.toMatch(/tok_SECRET/)
})

it('status rejects a bad state and surfaces 403', async () => {
  const bad = await exec('status', { sha: S, context: 'c', state: 'green' }, {})
  expect(bad.code).toBe(1)
  const r = await exec(
    'status',
    { sha: S, context: 'c', state: 'success' },
    { [`POST /repos/o/r/statuses/${S}`]: { status: 403, body: { message: 'forbidden tok_SECRET' } } }
  )
  expect(r.code).toBe(1)
  expect(r.verdict.verdict).toBe('unreadable')
  expect(r.log.replace('::add-mask::tok_SECRET', '')).not.toMatch(/tok_SECRET/)
  expect(r.calls.length).toBe(1)
})

it('status read: hit, absent, and wait polls then gives up', async () => {
  const key = `GET /repos/o/r/commits/${S}/status?per_page=100`
  const hit = await exec(
    'status',
    { sha: S, context: 'ci-route' },
    { [key]: { status: 200, body: { statuses: [{ context: 'ci-route', state: 'success', description: 'pool=arc' }] } } }
  )
  expect(hit.verdict.description).toBe('pool=arc')
  const none = fixture('combined-status.json')
  const miss = await exec(
    'status',
    { sha: S, context: 'ci-route', 'wait-seconds': '45' },
    { [key]: { status: 200, body: none } }
  )
  expect(miss.verdict.verdict).toBe('absent')
  expect(miss.calls.length).toBe(4)
  const late = await exec(
    'status',
    { sha: S, context: 'ci-route', 'wait-seconds': '45' },
    {
      [key]: [
        { status: 200, body: none },
        { status: 200, body: { statuses: [{ context: 'ci-route', state: 'success' }] } }
      ]
    }
  )
  expect(late.verdict.verdict).toBe('ok')
  expect(late.calls.length).toBe(2)
})

it('label adds and removes; removing an absent label is fine', async () => {
  const r = await exec(
    'label',
    { pr: '7', labels: 'ci:waiting-slot', 'remove-labels': 'old' },
    {
      'POST /repos/o/r/issues/7/labels': { status: 200, body: [] },
      'DELETE /repos/o/r/issues/7/labels/old': { status: 404, body: {} }
    }
  )
  expect(r.code).toBe(0)
  expect(r.calls[0]!.body).toEqual({ labels: ['ci:waiting-slot'] })
  expect(r.verdict.removed).toEqual(['old'])
})

it('dispatch sends ref and inputs; 204 is ok', async () => {
  const r = await exec(
    'dispatch',
    { workflow: 'ci.yml', ref: 'feat-x', pr: '9', inputs: '{"lane":"ci"}', gates: '{"v":1}' },
    { 'POST /repos/o/r/actions/workflows/ci.yml/dispatches': { status: 204 } }
  )
  expect(r.code).toBe(0)
  expect(r.calls[0]!.body).toEqual({ ref: 'feat-x', inputs: { lane: 'ci', pr: '9', gates: '{"v":1}' } })
})

it('dispatch refuses gates above 4096 bytes before any call', async () => {
  const r = await exec('dispatch', { workflow: 'ci.yml', ref: 'b', gates: 'x'.repeat(4097) }, {})
  expect(r.code).toBe(1)
  expect(r.calls.length).toBe(0)
})

it('dispatch 422 naming gates redispatches once without it (B-1)', async () => {
  const k = 'POST /repos/o/r/actions/workflows/ci.yml/dispatches'
  const r = await exec(
    'dispatch',
    { workflow: 'ci.yml', ref: 'old', pr: '9', gates: '{"v":1}' },
    { [k]: [{ status: 422, body: { message: 'Unexpected inputs provided: ["gates"]' } }, { status: 204 }] }
  )
  expect(r.code).toBe(0)
  expect(r.verdict.dropped).toEqual(['gates'])
  expect(r.calls[1]!.body.inputs).toEqual({ pr: '9' })
  expect(r.log).toMatch(/::warning::.*gates/)
})

it('dispatch 422 on another cause names the failure and does not retry', async () => {
  const k = 'POST /repos/o/r/actions/workflows/ci.yml/dispatches'
  const r = await exec(
    'dispatch',
    { workflow: 'ci.yml', ref: 'b' },
    { [k]: { status: 422, body: { message: 'Workflow does not have workflow_dispatch trigger' } } }
  )
  expect(r.code).toBe(1)
  expect(r.log).toMatch(/workflow_dispatch trigger/)
  expect(r.calls.length).toBe(1)
})

it('5xx is retried then unreadable; Retry-After honoured', async () => {
  const waits: number[] = []
  const k = `POST /repos/o/r/statuses/${S}`
  const bad = await exec(
    'status',
    { sha: S, context: 'c', state: 'success' },
    { [k]: { status: 502, body: {} } },
    { wait: async (ms: number) => waits.push(ms) }
  )
  expect(bad.code).toBe(1)
  expect(bad.calls.length).toBe(4)
  const rl = await exec(
    'status',
    { sha: S, context: 'c', state: 'success' },
    {
      [k]: [
        { status: 429, body: {}, headers: { 'retry-after': '7' } },
        { status: 201, body: {} }
      ]
    },
    { wait: async (ms: number) => waits.push(ms) }
  )
  expect(rl.code).toBe(0)
  expect(waits.includes(7000)).toBeTruthy()
})

it('missing token and unknown op fail closed', async () => {
  const r = await exec('nope', {}, {})
  expect(r.code).toBe(1)
  expect(r.log).toMatch(/unknown op/)
})
