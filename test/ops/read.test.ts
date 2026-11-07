import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { exec, fixture } from './helpers.js'

it('files: happy path, 404, cap, traversal, .git', async () => {
  const lic = fixture('contents-license.json')
  const dest = (await exec('ref', { ref: 'x' }, {})).dir
  const ok = await exec(
    'files',
    { paths: 'LICENSE', sha: 'main', dest },
    { 'GET /repos/o/r/contents/LICENSE?ref=main': { status: 200, body: lic } }
  )
  expect(ok.code).toBe(0)
  expect(ok.verdict.files[0].size).toBe(11357)
  expect(readFileSync(join(dest, 'LICENSE')).length).toBe(11357)

  const gone = await exec(
    'files',
    { paths: 'nope.txt', sha: 'main', dest },
    { 'GET /repos/o/r/contents/nope.txt?ref=main': { status: 404, body: {} } }
  )
  expect(gone.code).toBe(0)
  expect(gone.verdict.verdict).toBe('absent')
  expect(gone.verdict.ok).toBe(false)

  const big = await exec(
    'files',
    { paths: 'big.bin', sha: 'main', dest },
    { 'GET /repos/o/r/contents/big.bin?ref=main': { status: 200, body: { type: 'file', size: 1048577, content: '' } } }
  )
  expect(big.code).toBe(1)
  expect(big.log).toMatch(/cap/)

  for (const p of ['../x', 'a/../../x', '/etc/passwd', '.git/config', 'a/.git/b']) {
    const r = await exec('files', { paths: p, sha: 'main', dest }, {})
    expect(r.code).toBe(1)
    expect(r.calls.length).toBe(0)
  }
})

it('files: a directory answer is not a file', async () => {
  const dest = (await exec('ref', { ref: 'x' }, {})).dir
  const r = await exec(
    'files',
    { paths: 'src', sha: 'main', dest },
    { 'GET /repos/o/r/contents/src?ref=main': { status: 200, body: [{}] } }
  )
  expect(r.code).toBe(1)
})

it('call budget is enforced', async () => {
  const dest = (await exec('ref', { ref: 'x' }, {})).dir
  const lic = fixture('contents-license.json')
  const routes: Record<string, { status: number; body: unknown }> = {}
  for (const n of ['a', 'b', 'c'])
    routes[`GET /repos/o/r/contents/${n}?ref=main`] = { status: 200, body: { ...lic, size: 1 } }
  const r = await exec('files', { paths: 'a,b,c', sha: 'main', dest }, routes, { budget: 2 })
  expect(r.code).toBe(1)
  expect(r.log).toMatch(/budget 2/)
})

it('ref: recorded main, recorded 404, tags prefix', async () => {
  const main = fixture('ref-main.json')
  const ok = await exec('ref', { ref: 'main' }, { 'GET /repos/o/r/git/ref/heads/main': { status: 200, body: main } })
  expect(ok.verdict.sha).toBe('732b68254b3cb32a689fb9f189872fef2bca6434')
  const miss = await exec(
    'ref',
    { ref: 'nope' },
    { 'GET /repos/o/r/git/ref/heads/nope': { status: 404, body: fixture('ref-404.json') } }
  )
  expect(miss.code).toBe(0)
  expect(miss.verdict.verdict).toBe('absent')
  const tag = await exec('ref', { ref: 'tags/v1' }, { 'GET /repos/o/r/git/ref/tags/v1': { status: 200, body: main } })
  expect(tag.code).toBe(0)
})

it('403 on a read is unreadable, not absent', async () => {
  const r = await exec(
    'ref',
    { ref: 'main' },
    { 'GET /repos/o/r/git/ref/heads/main': { status: 403, body: { message: 'Resource not accessible' } } }
  )
  expect(r.code).toBe(1)
  expect(r.verdict.verdict).toBe('unreadable')
})
