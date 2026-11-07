import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exec, fixture } from './helpers.js';

test('files: happy path, 404, cap, traversal, .git', async () => {
  const lic = fixture('contents-license.json');
  const dest = (await exec('ref', { ref: 'x' }, {})).dir;
  const ok = await exec('files', { paths: 'LICENSE', sha: 'main', dest },
    { 'GET /repos/o/r/contents/LICENSE?ref=main': { status: 200, body: lic } });
  assert.equal(ok.code, 0);
  assert.equal(ok.verdict.files[0].size, 11357);
  assert.equal(readFileSync(join(dest, 'LICENSE')).length, 11357);

  const gone = await exec('files', { paths: 'nope.txt', sha: 'main', dest }, { 'GET /repos/o/r/contents/nope.txt?ref=main': { status: 404, body: {} } });
  assert.equal(gone.code, 0);
  assert.equal(gone.verdict.verdict, 'absent');
  assert.equal(gone.verdict.ok, false);

  const big = await exec('files', { paths: 'big.bin', sha: 'main', dest }, { 'GET /repos/o/r/contents/big.bin?ref=main': { status: 200, body: { type: 'file', size: 1048577, content: '' } } });
  assert.equal(big.code, 1);
  assert.match(big.log, /cap/);

  for (const p of ['../x', 'a/../../x', '/etc/passwd', '.git/config', 'a/.git/b']) {
    const r = await exec('files', { paths: p, sha: 'main', dest }, {});
    assert.equal(r.code, 1, p);
    assert.equal(r.calls.length, 0, `${p} made no call`);
  }
});

test('files: a directory answer is not a file', async () => {
  const dest = (await exec('ref', { ref: 'x' }, {})).dir;
  const r = await exec('files', { paths: 'src', sha: 'main', dest }, { 'GET /repos/o/r/contents/src?ref=main': { status: 200, body: [{}] } });
  assert.equal(r.code, 1);
});

test('call budget is enforced', async () => {
  const dest = (await exec('ref', { ref: 'x' }, {})).dir;
  const lic = fixture('contents-license.json');
  const routes = {};
  for (const n of ['a', 'b', 'c']) routes[`GET /repos/o/r/contents/${n}?ref=main`] = { status: 200, body: { ...lic, size: 1 } };
  const r = await exec('files', { paths: 'a,b,c', sha: 'main', dest }, routes, { budget: 2 });
  assert.equal(r.code, 1);
  assert.match(r.log, /budget 2/);
});

test('ref: recorded main, recorded 404, tags prefix', async () => {
  const main = fixture('ref-main.json');
  const ok = await exec('ref', { ref: 'main' }, { 'GET /repos/o/r/git/ref/heads/main': { status: 200, body: main } });
  assert.equal(ok.verdict.sha, '732b68254b3cb32a689fb9f189872fef2bca6434');
  const miss = await exec('ref', { ref: 'nope' }, { 'GET /repos/o/r/git/ref/heads/nope': { status: 404, body: fixture('ref-404.json') } });
  assert.equal(miss.code, 0);
  assert.equal(miss.verdict.verdict, 'absent');
  const tag = await exec('ref', { ref: 'tags/v1' }, { 'GET /repos/o/r/git/ref/tags/v1': { status: 200, body: main } });
  assert.equal(tag.code, 0);
});

test('403 on a read is unreadable, not absent', async () => {
  const r = await exec('ref', { ref: 'main' }, { 'GET /repos/o/r/git/ref/heads/main': { status: 403, body: { message: 'Resource not accessible' } } });
  assert.equal(r.code, 1);
  assert.equal(r.verdict.verdict, 'unreadable');
});
