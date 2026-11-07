import { expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { exec, fixture } from './helpers.js'

const C = '732b68254b3cb32a689fb9f189872fef2bca6434'
const L = '261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64'
const scratch = async () => (await exec('ref', { ref: 'x' }, {})).dir

it('commit: parents, message and per-file status from the recorded commit', async () => {
  const r = await exec(
    'commit',
    { sha: C },
    { [`GET /repos/o/r/commits/${C}`]: { status: 200, body: fixture('commit-initial.json') } }
  )
  expect(r.code).toBe(0)
  expect(r.verdict.parents).toEqual([])
  expect(r.verdict.message).toBe('Initial commit')
  expect(r.verdict.files.map((f: { path: string; status: string }) => [f.path, f.status])).toEqual([
    ['LICENSE', 'added']
  ])
  expect(r.verdict.truncated).toBe(false)
})

it('commit: bad sha makes no call; 404 absent; 300 files flagged truncated', async () => {
  const bad = await exec('commit', { sha: 'main' }, {})
  expect(bad.code).toBe(1)
  expect(bad.calls.length).toBe(0)
  const gone = await exec('commit', { sha: C }, { [`GET /repos/o/r/commits/${C}`]: { status: 404, body: {} } })
  expect(gone.verdict.verdict).toBe('absent')
  const c = fixture('commit-initial.json')
  c.files = Array.from({ length: 300 }, (_, n) => ({ filename: `f${n}`, status: 'added', sha: L }))
  const big = await exec('commit', { sha: C }, { [`GET /repos/o/r/commits/${C}`]: { status: 200, body: c } })
  expect(big.verdict.truncated).toBe(true)
})

it('tree: non-recursive root from the recorded tree, path-filtered', async () => {
  const k = `GET /repos/o/r/git/trees/${C}`
  const r = await exec('tree', { sha: C }, { [k]: { status: 200, body: fixture('tree-root.json') } })
  expect(r.verdict.entries.map((e: { path: string }) => e.path)).toEqual(['LICENSE'])
  const none = await exec(
    'tree',
    { sha: C, paths: 'deploy' },
    { [k]: { status: 200, body: fixture('tree-root.json') } }
  )
  expect(none.verdict.entries).toEqual([])
})

it('tree: truncated is unreadable; too many entries is unreadable', async () => {
  const k = `GET /repos/o/r/git/trees/${C}`
  const t = fixture('tree-root.json')
  const cut = await exec('tree', { sha: C }, { [k]: { status: 200, body: { ...t, truncated: true } } })
  expect(cut.code).toBe(1)
  const many = await exec('tree', { sha: C, 'max-entries': '0' }, { [k]: { status: 200, body: t } })
  expect(many.code).toBe(1)
  expect(many.log).toMatch(/above 0/)
})

it('tree: recursive is refused on a commit sha, allowed on a subtree sha', async () => {
  const t = fixture('tree-root.json')
  const root = await exec(
    'tree',
    { sha: C, recursive: 'true' },
    { [`GET /repos/o/r/git/commits/${C}`]: { status: 200, body: fixture('gitcommit.json') } }
  )
  expect(root.code).toBe(1)
  expect(root.log).toMatch(/refused/)
  expect(root.calls.length).toBe(1)
  const sub = await exec(
    'tree',
    { sha: L, recursive: 'true' },
    {
      [`GET /repos/o/r/git/commits/${L}`]: { status: 404, body: {} },
      [`GET /repos/o/r/git/trees/${L}?recursive=1`]: { status: 200, body: t }
    }
  )
  expect(sub.code).toBe(0)
})

it('blob: writes the recorded LICENSE under dest, size matches', async () => {
  const dest = await scratch()
  const r = await exec(
    'blob',
    { paths: `docs/LICENSE=${L}`, dest },
    { [`GET /repos/o/r/git/blobs/${L}`]: { status: 200, body: fixture('blob-license.json') } }
  )
  expect(r.code).toBe(0)
  expect(readFileSync(join(dest, 'docs/LICENSE')).length).toBe(11357)
})

it('blob: dedupes by sha across paths and through the cache dir', async () => {
  const dest = await scratch()
  const cache = await scratch()
  const route = { [`GET /repos/o/r/git/blobs/${L}`]: { status: 200, body: fixture('blob-license.json') } }
  const a = await exec('blob', { paths: `parent/L=${L}\nhead/L=${L}`, dest, cache }, route)
  expect(a.calls.length).toBe(1)
  expect(a.verdict.written).toBe(2)
  expect(a.verdict.fetched).toBe(1)
  const b = await exec('blob', { paths: `src/L=${L}`, dest, cache }, route)
  expect(b.calls.length).toBe(0)
  expect(existsSync(join(dest, 'src/L'))).toBeTruthy()
})

it('blob: cap, traversal, .git, malformed pair and absent blob are refused', async () => {
  const dest = await scratch()
  const big = { ...fixture('blob-license.json'), size: 1048577 }
  const cap = await exec(
    'blob',
    { paths: `a=${L}`, dest },
    { [`GET /repos/o/r/git/blobs/${L}`]: { status: 200, body: big } }
  )
  expect(cap.code).toBe(1)
  for (const p of [`../a=${L}`, `.git/x=${L}`, `a=nothex`, `/abs=${L}`]) {
    const r = await exec('blob', { paths: p, dest }, {})
    expect(r.code).toBe(1)
    expect(r.calls.length).toBe(0)
  }
  const gone = await exec(
    'blob',
    { paths: `a=${L}`, dest },
    { [`GET /repos/o/r/git/blobs/${L}`]: { status: 404, body: {} } }
  )
  expect(gone.code).toBe(1)
})

it('blob: at most 8 fetches in flight', async () => {
  const dest = await scratch()
  const shas = Array.from({ length: 20 }, (_, n) => n.toString(16).padStart(40, '0'))
  let live = 0,
    peak = 0
  const body = fixture('blob-license.json')
  const f = async () => {
    live++
    peak = Math.max(peak, live)
    await new Promise((r) => setTimeout(r, 5))
    live--
    return new Response(JSON.stringify({ ...body, size: 3, content: 'YWJj' }))
  }
  const r = await exec(
    'blob',
    { dest, paths: shas.map((s, n) => `f${n}=${s}`).join('\n') },
    {},
    { fetchImpl: f as unknown as typeof fetch, budget: 50 }
  )
  const code = r.code
  expect(code).toBe(0)
  expect(peak <= 8 && peak > 1).toBeTruthy()
})
