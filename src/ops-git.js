// Git data reads: commit, tree, blob. Trees and blobs, never a tarball.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Unreadable } from './api.js';
import { list } from './io.js';
import { FILE_CAP, checkRelPath, writeUnder } from './safe.js';

const SHA = /^[0-9a-f]{40}$/;
const need = (cond, msg) => { if (!cond) throw new Unreadable(msg); };

export async function commit(api, i) {
  need(SHA.test(i.sha), 'commit needs a 40-hex sha');
  const d = await api.read(`/repos/${i.repository}/commits/${i.sha}`);
  if (!d) return { verdict: 'absent', ok: false };
  const files = (d.files ?? []).map((f) => ({ path: f.filename, status: f.status, sha: f.sha, from: f.previous_filename }));
  // the API lists at most 300 files on this call; flag a possibly cut list
  return { verdict: 'ok', sha: d.sha, tree: d.commit.tree.sha, parents: d.parents.map((p) => p.sha), message: d.commit.message, files, truncated: files.length >= 300, ok: true };
}

export async function tree(api, i) {
  need(SHA.test(i.sha), 'tree needs a 40-hex sha');
  const recursive = i.recursive === 'true';
  const max = Number(i['max-entries'] || 3000);
  if (recursive) {
    // recursion is for subtrees: a commit sha (a root) is refused
    const isCommit = await api.read(`/repos/${i.repository}/git/commits/${i.sha}`);
    need(!isCommit, 'recursive tree refused on a commit (root) sha; walk to the subtree first');
  }
  const d = await api.read(`/repos/${i.repository}/git/trees/${i.sha}`, { query: recursive ? { recursive: 1 } : {} });
  if (!d) return { verdict: 'absent', ok: false };
  need(!d.truncated, 'tree truncated by the API');
  need(d.tree.length <= max, `tree has ${d.tree.length} entries, above ${max}`);
  const prefixes = list(i.paths ?? '');
  const keep = (e) => !prefixes.length || prefixes.some((p) => e.path === p || e.path.startsWith(`${p}/`));
  const entries = d.tree.filter(keep).map((e) => ({ path: e.path, type: e.type, mode: e.mode, sha: e.sha, size: e.size }));
  return { verdict: 'ok', sha: d.sha, entries, ok: true };
}

// paths: lines "<relative path>=<blob sha>". Fetch each sha once (a shared `cache` dir spans steps), 8 at a time.
export async function blob(api, i) {
  need(i.dest, 'blob needs dest');
  const pairs = list(i.paths ?? '').map((l) => {
    const [path, sha] = l.split('=');
    need(path && SHA.test(sha ?? ''), `blob pair must be path=sha: ${l}`);
    return [checkRelPath(path), sha];
  });
  need(pairs.length, 'blob needs paths');
  const bytes = new Map();
  const fetchOne = async (sha) => {
    const cached = i.cache && join(i.cache, sha);
    if (cached && existsSync(cached)) return readFileSync(cached);
    const d = await api.read(`/repos/${i.repository}/git/blobs/${sha}`);
    need(d, `blob ${sha} absent`);
    need(d.size <= FILE_CAP, `blob ${sha}: ${d.size} bytes above the ${FILE_CAP} cap`);
    const b = Buffer.from(d.content, d.encoding === 'base64' ? 'base64' : 'utf8');
    if (cached) { mkdirSync(i.cache, { recursive: true }); writeFileSync(cached, b); }
    return b;
  };
  const shas = [...new Set(pairs.map((p) => p[1]))];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, shas.length) }, async () => {
    while (next < shas.length) { const s = shas[next++]; bytes.set(s, await fetchOne(s)); }
  }));
  for (const [path, sha] of pairs) writeUnder(i.dest, path, bytes.get(sha));
  return { verdict: 'ok', written: pairs.length, fetched: shas.length, ok: true };
}
