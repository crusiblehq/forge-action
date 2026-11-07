// GitHub REST client: bounded retries, call budget, fail closed.
export class Unreadable extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function client({ token, fetchImpl = globalThis.fetch, base = 'https://api.github.com', budget = 250, wait = sleep, retries = 3 }) {
  let calls = 0;
  async function request(method, path, { body, query } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      if (++calls > budget) throw new Unreadable(`call budget ${budget} exhausted`);
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'crusiblehq-forge-action',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        if (attempt < retries) { await wait(500 * 2 ** attempt); continue; }
        throw new Unreadable(`network: ${e.message}`);
      }
      const secondary = res.status === 429 || (res.status === 403 && res.headers.get('retry-after') !== null);
      if ((res.status >= 500 || secondary) && attempt < retries) {
        const ra = Number(res.headers.get('retry-after'));
        await wait(ra > 0 ? ra * 1000 : 500 * 2 ** attempt);
        continue;
      }
      if (res.status >= 500 || secondary) throw new Unreadable(`${method} ${path}: HTTP ${res.status} after ${attempt + 1} tries`);
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = text; } }
      return { status: res.status, data, headers: res.headers };
    }
  }
  // Read that treats 404 as absent, any other non-2xx as unreadable.
  async function read(path, opts) {
    const r = await request('GET', path, opts);
    if (r.status === 404) return null;
    if (r.status >= 300) throw new Unreadable(`GET ${path}: HTTP ${r.status} ${r.data?.message ?? ''}`.trim());
    return r.data;
  }
  return { request, read, calls: () => calls };
}
