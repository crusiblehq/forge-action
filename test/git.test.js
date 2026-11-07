import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { exec, fixture } from './helpers.js';

const C = '732b68254b3cb32a689fb9f189872fef2bca6434';
const L = '261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64';
const scratch = async () => (await exec('ref', { ref: 'x' }, {})).dir;

test('commit: parents, message and per-file status from the recorded commit', async () => {
  const r = await exec('commit', { sha: C }, { [`GET /repos/o/r/commits/${C}`]: { status: 200, body: fixture('commit-initial.json') } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.verdict.parents, []);
  assert.equal(r.verdict.message, 'Initial commit');
  assert.deepEqual(r.verdict.files.map((f) => [f.path, f.status]), [['LICENSE', 'added']]);
  assert.equal(r.verdict.truncated, false);
});

test('commit: bad sha makes no call; 404 absent; 300 files flagged truncated', async () => {
  const bad = await exec('commit', { sha: 'main' }, {});
  assert.equal(bad.code, 1);
  assert.equal(bad.calls.length, 0);
  const gone = await exec('commit', { sha: C }, { [`GET /repos/o/r/commits/${C}`]: { status: 404, body: {} } });
  assert.equal(gone.verdict.verdict, 'absent');
  const c = fixture('commit-initial.json');
  c.files = Array.from({ length: 300 }, (_, n) => ({ filename: `f${n}`, status: 'added', sha: L }));
  const big = await exec('commit', { sha: C }, { [`GET /repos/o/r/commits/${C}`]: { status: 200, body: c } });
  assert.equal(big.verdict.truncated, true);
});

test('tree: non-recursive root from the recorded tree, path-filtered', async () => {
  const k = `GET /repos/o/r/git/trees/${C}`;
  const r = await exec('tree', { sha: C }, { [k]: { status: 200, body: fixture('tree-root.json') } });
  assert.deepEqual(r.verdict.entries.map((e) => e.path), ['LICENSE']);
  const none = await exec('tree', { sha: C, paths: 'deploy' }, { [k]: { status: 200, body: fixture('tree-root.json') } });
  assert.deepEqual(none.verdict.entries, []);
});

test('tree: truncated is unreadable; too many entries is unreadable', async () => {
  const k = `GET /repos/o/r/git/trees/${C}`;
  const t = fixture('tree-root.json');
  const cut = await exec('tree', { sha: C }, { [k]: { status: 200, body: { ...t, truncated: true } } });
  assert.equal(cut.code, 1);
  const many = await exec('tree', { sha: C, 'max-entries': '0' }, { [k]: { status: 200, body: t } });
  assert.equal(many.code, 1);
  assert.match(many.log, /above 0/);
});

test('tree: recursive is refused on a commit sha, allowed on a subtree sha', async () => {
  const t = fixture('tree-root.json');
  const root = await exec('tree', { sha: C, recursive: 'true' }, { [`GET /repos/o/r/git/commits/${C}`]: { status: 200, body: fixture('gitcommit.json') } });
  assert.equal(root.code, 1);
  assert.match(root.log, /refused/);
  assert.equal(root.calls.length, 1, 'refused before the tree call');
  const sub = await exec('tree', { sha: L, recursive: 'true' }, {
    [`GET /repos/o/r/git/commits/${L}`]: { status: 404, body: {} },
    [`GET /repos/o/r/git/trees/${L}?recursive=1`]: { status: 200, body: t },
  });
  assert.equal(sub.code, 0);
});

test('blob: writes the recorded LICENSE under dest, size matches', async () => {
  const dest = await scratch();
  const r = await exec('blob', { paths: `docs/LICENSE=${L}`, dest }, { [`GET /repos/o/r/git/blobs/${L}`]: { status: 200, body: fixture('blob-license.json') } });
  assert.equal(r.code, 0);
  assert.equal(readFileSync(join(dest, 'docs/LICENSE')).length, 11357);
});

test('blob: dedupes by sha across paths and through the cache dir', async () => {
  const dest = await scratch();
  const cache = await scratch();
  const route = { [`GET /repos/o/r/git/blobs/${L}`]: { status: 200, body: fixture('blob-license.json') } };
  const a = await exec('blob', { paths: `parent/L=${L}\nhead/L=${L}`, dest, cache }, route);
  assert.equal(a.calls.length, 1);
  assert.equal(a.verdict.written, 2);
  assert.equal(a.verdict.fetched, 1);
  const b = await exec('blob', { paths: `src/L=${L}`, dest, cache }, route);
  assert.equal(b.calls.length, 0, 'second step reads the cache');
  assert.ok(existsSync(join(dest, 'src/L')));
});

test('blob: cap, traversal, .git, malformed pair and absent blob are refused', async () => {
  const dest = await scratch();
  const big = { ...fixture('blob-license.json'), size: 1048577 };
  const cap = await exec('blob', { paths: `a=${L}`, dest }, { [`GET /repos/o/r/git/blobs/${L}`]: { status: 200, body: big } });
  assert.equal(cap.code, 1);
  for (const p of [`../a=${L}`, `.git/x=${L}`, `a=nothex`, `/abs=${L}`]) {
    const r = await exec('blob', { paths: p, dest }, {});
    assert.equal(r.code, 1, p);
    assert.equal(r.calls.length, 0, p);
  }
  const gone = await exec('blob', { paths: `a=${L}`, dest }, { [`GET /repos/o/r/git/blobs/${L}`]: { status: 404, body: {} } });
  assert.equal(gone.code, 1);
});

test('blob: at most 8 fetches in flight', async () => {
  const dest = await scratch();
  const shas = Array.from({ length: 20 }, (_, n) => n.toString(16).padStart(40, '0'));
  let live = 0, peak = 0;
  const body = fixture('blob-license.json');
  const f = async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return new Response(JSON.stringify({ ...body, size: 3, content: 'YWJj' })); };
  const { run } = await import('../src/main.js');
  const env = { INPUT_OP: 'blob', INPUT_TOKEN: 't', INPUT_DEST: dest, INPUT_PATHS: shas.map((s, n) => `f${n}=${s}`).join('\n'), GITHUB_REPOSITORY: 'o/r' };
  const code = await run(env, { out: () => {}, client: { fetchImpl: f, budget: 50 } });
  assert.equal(code, 0);
  assert.ok(peak <= 8 && peak > 1, `peak ${peak}`);
});
