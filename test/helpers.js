import { readFileSync, mkdtempSync, readFileSync as rf } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { client } from '../src/api.js';
import { run } from '../src/main.js';

export const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));

// routes: { 'GET /path?query': response | [response, ...] }; response = {status, body, headers}
export function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}${u.search}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.authorization });
    let r = routes[key];
    if (Array.isArray(r)) r = r.length > 1 ? r.shift() : r[0];
    r ??= { status: 599, body: { message: `no route ${key}` } };
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers ?? {} });
  };
  return { f, calls };
}

export async function exec(op, inputs, routes, extra = {}) {
  const { f, calls } = fakeFetch(routes);
  const dir = mkdtempSync(join(tmpdir(), 'fa-'));
  const outFile = join(dir, 'out');
  const env = { GITHUB_OUTPUT: outFile, GITHUB_REPOSITORY: 'o/r', INPUT_OP: op, INPUT_TOKEN: 'tok_SECRET' };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  let log = '';
  const code = await run(env, {
    out: (s) => { log += s; },
    sleep: async () => {},
    client: { fetchImpl: f, wait: async () => {}, ...extra },
  });
  let text = '';
  try { text = rf(outFile, 'utf8'); } catch { /* none */ }
  const m = /verdict<<(\S+)\n([\s\S]*?)\n\1\n/.exec(text);
  return { code, log, calls, verdict: m ? JSON.parse(m[2]) : null, outputs: text, dir };
}
