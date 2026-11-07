import { expect, it } from 'vitest'
import { client, Unreadable } from '../../src/ops/api.js'
import { exec } from './helpers.js'

const S = '732b68254b3cb32a689fb9f189872fef2bca6434'
const ok = () => new Response('{}', { status: 200 })

it('honours a Retry-After within the cap', async () => {
  const waits: number[] = []
  const seq = [new Response('', { status: 429, headers: { 'retry-after': '30' } }), ok()]
  const api = client({
    token: 't',
    fetchImpl: (async () => seq.shift()!) as unknown as typeof fetch,
    wait: async (ms) => void waits.push(ms)
  })
  expect((await api.request('GET', '/x')).status).toBe(200)
  expect(waits).toEqual([30_000])
})

it('fails rather than sleeping past the Retry-After cap', async () => {
  const waits: number[] = []
  const f = (async () =>
    new Response('', { status: 403, headers: { 'retry-after': '3600' } })) as unknown as typeof fetch
  const api = client({ token: 't', fetchImpl: f, wait: async (ms) => void waits.push(ms) })
  await expect(api.request('GET', '/x')).rejects.toThrow(/Retry-After 3600s above the 60s cap/)
  expect(waits).toEqual([])
})

it('retries a network error with backoff, then succeeds', async () => {
  const waits: number[] = []
  let n = 0
  const f = (async () => {
    if (++n < 3) throw new TypeError('fetch failed')
    return ok()
  }) as unknown as typeof fetch
  const api = client({ token: 't', fetchImpl: f, wait: async (ms) => void waits.push(ms) })
  expect((await api.request('GET', '/x')).status).toBe(200)
  expect(waits).toEqual([500, 1000])
  expect(api.calls()).toBe(3)
})

it('gives up on a persistent network error as Unreadable', async () => {
  const f = (async () => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch
  const api = client({ token: 't', fetchImpl: f, wait: async () => {}, retries: 2 })
  await expect(api.request('GET', '/x')).rejects.toBeInstanceOf(Unreadable)
  expect(api.calls()).toBe(3)
})

it('scrubs the token from a network error in the log, the verdict and the outputs', async () => {
  const f = (async () => {
    throw new TypeError('connect to https://x-access-token:tok_SECRET@api.github.com failed')
  }) as unknown as typeof fetch
  const r = await exec('status', { sha: S, context: 'c' }, {}, { fetchImpl: f, retries: 0 })
  expect(r.code).toBe(1)
  expect(r.verdict.why).toContain('***')
  const text = r.log.replace('::add-mask::tok_SECRET', '') + r.outputs
  expect(text).not.toContain('tok_SECRET')
})

it('requires a token', async () => {
  const r = await exec('status', { token: '', sha: S, context: 'c' }, {})
  expect(r.code).toBe(1)
  expect(r.verdict.why).toMatch(/token input is required/)
})

it.each<Record<string, string>>([
  { repository: '../../orgs/x' },
  { repository: 'o/r/../../x' },
  { repository: 'o/..' },
  { pr: '1/../../x' }
])('refuses a hostile input %o before any call', async (inputs) => {
  const r = await exec('label', { labels: 'a', pr: '1', ...inputs }, {})
  expect(r.code).toBe(1)
  expect(r.verdict.why).toMatch(/^bad (repository|pr)/)
  expect(r.calls.length).toBe(0)
})

it.each(['main', `${S}/../x`])('status refuses a sha that is not 40 hex: %s', async (sha) => {
  const r = await exec('status', { sha, context: 'c', state: 'success' }, {})
  expect(r.code).toBe(1)
  expect(r.verdict.why).toMatch(/^bad sha/)
  expect(r.calls.length).toBe(0)
})
