import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { exec, fixture } from './helpers.js'

const H = '8140fd8724c2203d95a0df770d2fce5ac53968ba'
const pull = (o: object = {}) => ({ ...fixture('pull-1.json'), ...o })
const P = '/repos/o/r/pulls/1'
const ST = `/repos/o/r/commits/${H}/statuses?per_page=100&page=1`
const FILES = '/repos/o/r/pulls/1/files?per_page=100&page=1'
const ok = (body: unknown) => ({ status: 200, body })
const base: Record<string, { status: number; body?: unknown } | Array<{ status: number; body?: unknown }>> = {
  [`GET ${P}`]: ok(pull()),
  [`GET ${ST}`]: ok([]),
  [`GET ${FILES}`]: ok(fixture('pull-1-files.json'))
}
const run = (inputs: Record<string, string>, routes = {}) =>
  exec('pr-state', { pr: '1', sha: H, 'delay-seconds': '0', ...inputs }, { ...base, ...routes })

it('pr-state: open at the expected head, mergeable, lists the changed files from the recorded response', async () => {
  const r = await run({})
  expect(r.code).toBe(0)
  expect(r.verdict).toMatchObject({ verdict: 'ok', ok: true, pr: 1, head_sha: H, base_ref: 'main', reads: 1 })
  expect(r.verdict.files).toHaveLength(34)
  expect(r.verdict.files[0]).toEqual({ path: expect.any(String), status: expect.any(String) })
})

it('pr-state: closed and merged are closed', async () => {
  expect((await run({}, { [`GET ${P}`]: ok(pull({ state: 'closed' })) })).verdict.verdict).toBe('closed')
  const m = await run({}, { [`GET ${P}`]: ok(pull({ state: 'closed', merged: true })) })
  expect(m.verdict).toMatchObject({ verdict: 'closed', state: 'merged', ok: false })
})

it('pr-state: a head that differs on both reads is superseded; one that comes back is not', async () => {
  const moved = pull({ head: { ...pull().head, sha: 'a'.repeat(40) } })
  const s = await run({}, { [`GET ${P}`]: ok(moved) })
  expect(s.verdict).toMatchObject({ verdict: 'superseded', expected_sha: H, ok: false })
  expect(s.calls.filter((c) => c.key === `GET ${P}`)).toHaveLength(2)
  const back = await run({}, { [`GET ${P}`]: [ok(moved), ok(pull())] })
  expect(back.verdict.verdict).toBe('ok')
})

it('pr-state: mergeable fails only when all 5 reads conflict', async () => {
  const dirty = ok(pull({ mergeable: false, mergeable_state: 'dirty' }))
  const all = await run({}, { [`GET ${P}`]: dirty })
  expect(all.verdict).toMatchObject({ verdict: 'conflict', reads: 5, ok: false })
  expect(all.calls.filter((c) => c.key === `GET ${P}`)).toHaveLength(5)
  const late = await run({}, { [`GET ${P}`]: [dirty, dirty, ok(pull())] })
  expect(late.verdict).toMatchObject({ verdict: 'ok', reads: 3 })
  const unknown = await run({}, { [`GET ${P}`]: ok(pull({ mergeable: null, mergeable_state: 'unknown' })) })
  expect(unknown.verdict.verdict).toBe('ok')
})

it('pr-state: a head that moves during the mergeable reads is unreadable', async () => {
  const dirty = ok(pull({ mergeable: false, mergeable_state: 'dirty' }))
  const moved = ok(pull({ head: { ...pull().head, sha: 'b'.repeat(40) } }))
  expect((await run({}, { [`GET ${P}`]: [dirty, moved] })).code).toBe(1)
})

const RUN = '/repos/o/r/actions/runs/777'
const reuse = {
  [`GET ${ST}`]: ok(fixture('status-ci-required.json')),
  [`GET ${RUN}`]: ok(fixture('run-ci-dispatch.json'))
}

it('pr-state: an earlier ci.yml dispatch of this pr and sha with a green ci-required is reused', async () => {
  const r = await run({ base: 'main' }, reuse)
  expect(r.verdict).toMatchObject({ verdict: 'reused', run: 777, ok: false })
})

it('pr-state: each reuse condition refuses', async () => {
  const bad = (o: object) => ({ ...reuse, [`GET ${RUN}`]: ok({ ...fixture('run-ci-dispatch.json'), ...o }) })
  for (const o of [
    { head_sha: 'c'.repeat(40) },
    { display_title: 'CI PR #2 @x' },
    { event: 'push' },
    { status: 'in_progress' },
    { path: '.github/workflows/other.yml' }
  ])
    expect((await run({}, bad(o))).verdict.verdict).toBe('ok')
  expect((await run({ base: 'release' }, reuse)).verdict.verdict).toBe('ok')
  const st = fixture('status-ci-required.json')
  const withState = (o: object) => ({ ...reuse, [`GET ${ST}`]: ok([{ ...st[0], ...o }]) })
  expect((await run({}, withState({ state: 'failure' }))).verdict.verdict).toBe('ok')
  expect((await run({}, withState({ creator: { login: 'someone' } }))).verdict.verdict).toBe('ok')
  expect((await run({}, withState({ target_url: 'https://evil.example/actions/runs/777' }))).verdict.verdict).toBe('ok')
})

it('pr-state: a status list that never shows ci-required in 3 full pages is unreadable', async () => {
  const full = Array.from({ length: 100 }, () => ({ context: 'x', state: 'success' }))
  const routes: Record<string, { status: number; body: unknown }> = {}
  for (const p of [1, 2, 3]) routes[`GET /repos/o/r/commits/${H}/statuses?per_page=100&page=${p}`] = ok(full)
  const r = await run({}, routes)
  expect(r.code).toBe(1)
  expect(r.log).toMatch(/not in the first 3 pages/)
})

it('pr-state: 404, 403, a 5xx that outlasts the retries, a short file list and bad inputs are unreadable', async () => {
  for (const status of [404, 403, 502]) {
    const r = await run({}, { [`GET ${P}`]: { status, body: { message: 'x' } } })
    expect(r.code).toBe(1)
    expect(r.verdict.verdict).toBe('unreadable')
  }
  const short = await run({}, { [`GET ${P}`]: ok(pull({ changed_files: 35 })) })
  expect(short.log).toMatch(/changed files read 34 of 35/)
  expect((await run({ sha: 'abc' })).log).toMatch(/40-hex/)
  expect((await run({ 'delay-seconds': '61' })).log).toMatch(/60 s cap/)
  expect((await run({ pr: '1/../2' })).code).toBe(1)
})

const pin = (inputs: Record<string, string> = {}, routes = {}) =>
  exec(
    'dispatch-pin',
    { pr: '1', sha: H, ...inputs },
    { ...base, [`GET /repos/o/r/git/ref/heads/v1-initial`]: ok({ object: { sha: H, type: 'commit' } }), ...routes }
  )

it('dispatch-pin: the ref tip equals the expected sha; outputs the pull request facts', async () => {
  const r = await pin()
  expect(r.verdict).toMatchObject({
    verdict: 'ok',
    head_sha: H,
    head_ref: 'v1-initial',
    base_ref: 'main',
    head_repo: expect.any(String)
  })
  expect(r.verdict.base_sha).toMatch(/^[0-9a-f]{40}$/)
  expect(r.verdict.author_id).toBe(3044333)
})

it('dispatch-pin: a moved tip, a moved pull request head, an absent ref and a closed pull request are refused', async () => {
  const tip = { 'GET /repos/o/r/git/ref/heads/v1-initial': ok({ object: { sha: 'd'.repeat(40), type: 'commit' } }) }
  expect((await pin({}, tip)).log).toMatch(/tip is d{40}/)
  expect((await pin({ sha: 'e'.repeat(40) })).log).toMatch(/head is 8140fd8/)
  expect((await pin({}, { 'GET /repos/o/r/git/ref/heads/v1-initial': { status: 404, body: {} } })).log).toMatch(
    /does not exist/
  )
  expect((await pin({}, { [`GET ${P}`]: ok(pull({ state: 'closed' })) })).code).toBe(1)
  expect(
    (await pin({ ref: 'other/x' }, { 'GET /repos/o/r/git/ref/heads/other/x': ok({ object: { sha: 'd'.repeat(40) } }) }))
      .code
  ).toBe(1)
})

it('body-text: title and body go to files under dest, never to the verdict, the outputs or the log', async () => {
  const body = 'secret-ish body\n'.repeat(4000)
  const t = (b: unknown) =>
    exec('body-text', { pr: '1', sha: H }, { ...base, [`GET ${P}`]: ok(pull({ body: b, title: 'feat: t' })) })
  const dest = (await exec('ref', { ref: 'x' }, {})).dir
  const r = await exec(
    'body-text',
    { pr: '1', sha: H, dest },
    { ...base, [`GET ${P}`]: ok(pull({ body, title: 'feat: t' })) }
  )
  expect(r.verdict).toEqual({ verdict: 'ok', title: 'feat: t', title_chars: 7, body_chars: body.length, ok: true })
  expect(readFileSync(join(dest, 'body.md'), 'utf8')).toBe(body)
  expect(readFileSync(join(dest, 'title.txt'), 'utf8')).toBe('feat: t')
  expect(r.outputs + r.log).not.toContain('secret-ish')
  expect((await t('x')).log).toMatch(/needs dest/)
  const nul = await exec('body-text', { pr: '1', sha: H, dest }, { ...base, [`GET ${P}`]: ok(pull({ body: null })) })
  expect(nul.verdict.body_chars).toBe(0)
  const moved = await exec('body-text', { pr: '1', sha: 'f'.repeat(40), dest }, base)
  expect(moved.code).toBe(1)
})

const JOBS = '/repos/o/r/actions/runs/777/attempts/1/jobs?per_page=100&page=1'
const runBody = (o: object = {}) => ({ id: 777, status: 'completed', conclusion: 'success', run_attempt: 1, ...o })

it('run-jobs: jobs of the latest attempt with conclusions, from the recorded response', async () => {
  const r = await exec(
    'run-jobs',
    { run: '777' },
    { 'GET /repos/o/r/actions/runs/777': ok(runBody()), [`GET ${JOBS}`]: ok(fixture('run-jobs.json')) }
  )
  expect(r.verdict).toMatchObject({ verdict: 'ok', run: 777, attempt: 1, conclusion: 'success', ok: true })
  expect(r.verdict.jobs.map((j: { name: string; conclusion: string }) => [j.name, j.conclusion])).toEqual([
    ['test', 'success'],
    ['self-test', 'success']
  ])
  expect(r.outputs).not.toContain('tok_SECRET')
})

it('run-jobs: a running run is incomplete, a missing run is absent, a short job list and a 403 fail', async () => {
  const r = (b: object, jobs: { status: number; body?: unknown }) =>
    exec('run-jobs', { run: '777', attempt: '1' }, { 'GET /repos/o/r/actions/runs/777': ok(b), [`GET ${JOBS}`]: jobs })
  expect((await r(runBody({ status: 'in_progress' }), ok(fixture('run-jobs.json')))).verdict).toMatchObject({
    verdict: 'incomplete',
    ok: false
  })
  expect(
    (await exec('run-jobs', { run: '9' }, { 'GET /repos/o/r/actions/runs/9': { status: 404 } })).verdict.verdict
  ).toBe('absent')
  const short = { ...fixture('run-jobs.json'), total_count: 150 }
  expect((await r(runBody(), ok(short))).log).toMatch(/2 of 150 jobs/)
  expect((await r(runBody(), { status: 403, body: { message: 'no' } })).code).toBe(1)
  expect((await exec('run-jobs', {}, {})).log).toMatch(/needs run/)
})

const WF = (n: number) =>
  `/repos/o/r/actions/workflows/ci.yml/runs?status=completed&branch=main&event=push&per_page=${n}`
const job = (name: string, conclusion: string) => ({ name, conclusion })
const jobsOf = (id: number, jobs: object[]) => ({
  [`GET /repos/o/r/actions/runs/${id}/attempts/1/jobs?per_page=100&page=1`]: ok({ total_count: jobs.length, jobs })
})

it('lane-last-green: newest green run per lane as a 12-hex sha; a matrix lane is green only when all legs are; missing is not never-green', async () => {
  const runs = [1, 2, 3].map((id) => ({ id, run_attempt: 1, head_sha: `${id}`.repeat(40) }))
  const r = await exec(
    'lane-last-green',
    { lanes: 'node,go,www' },
    {
      [`GET ${WF(30)}`]: ok({ workflow_runs: runs }),
      ...jobsOf(1, [job('node (api)', 'success'), job('node (web)', 'failure'), job('go', 'success')]),
      ...jobsOf(2, [job('stage / node (api)', 'success'), job('stage / node (web)', 'success'), job('go', 'failure')]),
      ...jobsOf(3, [job('go', 'success')])
    }
  )
  expect(r.verdict).toEqual({
    verdict: 'ok',
    lanes: { go: '111111111111', node: '222222222222' },
    missing: ['www'],
    scanned: 3,
    ok: true
  })
})

it('lane-last-green: stops scanning once every lane is found; bad lanes, max-runs and a failed jobs read are refused', async () => {
  const runs = [1, 2].map((id) => ({ id, run_attempt: 1, head_sha: `${id}`.repeat(40) }))
  const r = await exec(
    'lane-last-green',
    { lanes: 'go', ref: 'main', 'max-runs': '5' },
    { [`GET ${WF(5)}`]: ok({ workflow_runs: runs }), ...jobsOf(1, [job('go', 'success')]) }
  )
  expect(r.verdict.scanned).toBe(1)
  expect((await exec('lane-last-green', { lanes: 'a b;c' }, {})).code).toBe(1)
  expect((await exec('lane-last-green', { lanes: 'go', 'max-runs': '101' }, {})).log).toMatch(/1-100/)
  const bad = await exec(
    'lane-last-green',
    { lanes: 'go' },
    {
      [`GET ${WF(30)}`]: ok({ workflow_runs: runs }),
      'GET /repos/o/r/actions/runs/1/attempts/1/jobs?per_page=100&page=1': { status: 500 }
    }
  )
  expect(bad.code).toBe(1)
})
