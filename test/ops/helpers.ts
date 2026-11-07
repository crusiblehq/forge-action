import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execOp } from '../../src/ops/index.js'

export const fixture = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8'))

type R = { status: number; body?: unknown; headers?: Record<string, string> }
// routes: { 'GET /path?query': response | [response, ...] }
export function fakeFetch(routes: Record<string, R | R[]>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls: Array<{ key: string; body?: any; auth: string }> = []
  const f = (async (url: URL, init: RequestInit) => {
    const u = new URL(url)
    const key = `${init.method} ${u.pathname}${u.search}`
    calls.push({
      key,
      body: init.body ? JSON.parse(init.body as string) : undefined,
      auth: (init.headers as Record<string, string>).authorization!
    })
    let r = routes[key]
    if (Array.isArray(r)) r = r.length > 1 ? r.shift()! : r[0]!
    r ??= { status: 599, body: { message: `no route ${key}` } }
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: r.headers ?? {}
    })
  }) as unknown as typeof fetch
  return { f, calls }
}

export async function exec(
  op: string,
  inputs: Record<string, string>,
  routes: Record<string, R | R[]>,
  extra: Record<string, unknown> = {}
) {
  const { f, calls } = fakeFetch(routes)
  const dir = mkdtempSync(join(tmpdir(), 'fa-'))
  const all: Record<string, string> = { op, token: 'tok_SECRET', ...inputs }
  let log = ''
  const out: Record<string, string> = {}
  const code = await execOp({
    get: (n) => all[n] ?? '',
    repository: 'o/r',
    mask: (v) => void (log += `::add-mask::${v}\n`),
    output: (n, v) => void (out[n] = String(v)),
    error: (m) => void (log += `::error::${m}\n`),
    log: (l) => void (log += `${l}\n`),
    sleep: async () => {},
    client: { fetchImpl: f, wait: async () => {}, ...extra }
  })
  const outputs = JSON.stringify(out)
  return { code, log, calls, verdict: out.verdict ? JSON.parse(out.verdict) : null, outputs, dir }
}
