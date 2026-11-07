// REST client for the op mode: bounded retries (5xx, 429, secondary rate limit with Retry-After), a call budget, fail closed.
export class Unreadable extends Error {}

export interface Res {
  status: number
  data: any // eslint-disable-line @typescript-eslint/no-explicit-any
}
export interface Api {
  request(method: string, path: string, o?: { body?: unknown; query?: Record<string, string | number> }): Promise<Res>
  read(path: string, o?: { query?: Record<string, string | number> }): Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
  calls(): number
}
export interface ClientOpts {
  token: string
  fetchImpl?: typeof fetch
  base?: string
  budget?: number
  wait?: (ms: number) => Promise<void>
  retries?: number
  maxWaitMs?: number
}

/** Longest single Retry-After honoured; a larger value fails the step rather than stalling it to the job timeout. */
export const MAX_WAIT_MS = 60_000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function client({
  token,
  fetchImpl = globalThis.fetch,
  base = 'https://api.github.com',
  budget = 250,
  wait = sleep,
  retries = 3,
  maxWaitMs = MAX_WAIT_MS
}: ClientOpts): Api {
  let calls = 0
  async function request(
    method: string,
    path: string,
    { body, query }: { body?: unknown; query?: Record<string, string | number> } = {}
  ): Promise<Res> {
    const url = new URL(base + path)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v))
    for (let attempt = 0; ; attempt++) {
      if (++calls > budget) throw new Unreadable(`call budget ${budget} exhausted`)
      let res: Response
      try {
        res = await fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'crusiblehq-forge-action',
            ...(body === undefined ? {} : { 'content-type': 'application/json' })
          },
          body: body === undefined ? undefined : JSON.stringify(body)
        })
      } catch (e) {
        if (attempt < retries) {
          await wait(500 * 2 ** attempt)
          continue
        }
        throw new Unreadable(`network: ${(e as Error).message}`)
      }
      const secondary = res.status === 429 || (res.status === 403 && res.headers.get('retry-after') !== null)
      if (res.status >= 500 || secondary) {
        if (attempt >= retries) throw new Unreadable(`${method} ${path}: HTTP ${res.status} after ${attempt + 1} tries`)
        const ra = Number(res.headers.get('retry-after'))
        if (ra * 1000 > maxWaitMs)
          throw new Unreadable(`${method} ${path}: Retry-After ${ra}s above the ${maxWaitMs / 1000}s cap`)
        await wait(ra > 0 ? ra * 1000 : 500 * 2 ** attempt)
        continue
      }
      const text = await res.text()
      let data: unknown = null
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          data = text
        }
      }
      return { status: res.status, data }
    }
  }
  // 404 is absent (null); any other non-2xx is unreadable.
  async function read(path: string, o?: { query?: Record<string, string | number> }) {
    const r = await request('GET', path, o)
    if (r.status === 404) return null
    if (r.status >= 300) throw new Unreadable(`GET ${path}: HTTP ${r.status} ${r.data?.message ?? ''}`.trim())
    return r.data
  }
  return { request, read, calls: () => calls }
}
