import test from 'node:test';
import assert from 'node:assert/strict';
import { exec, fixture } from './helpers.js';

const S = '732b68254b3cb32a689fb9f189872fef2bca6434';

test('pulls: one PR reads state, heads and mergeable from the recorded response', async () => {
  const r = await exec('pulls', { pr: '1' }, { 'GET /repos/o/r/pulls/1': { status: 200, body: fixture('pull-1.json') } });
  assert.equal(r.code, 0);
  assert.equal(r.verdict.pull.number, 1);
  assert.equal(r.verdict.pull.head_ref, 'v1-initial');
  assert.equal(r.verdict.pull.base_ref, 'main');
  assert.match(r.verdict.pull.head_sha, /^[0-9a-f]{40}$/);
  assert.ok(Array.isArray(r.verdict.pull.labels));
});

test('pulls: list, 404 is absent, 403 is unreadable', async () => {
  const l = await exec('pulls', { base: 'main' }, { 'GET /repos/o/r/pulls?state=open&base=main&per_page=100&page=1': { status: 200, body: fixture('pulls-open.json') } });
  assert.equal(l.verdict.pulls.length, fixture('pulls-open.json').length);
  const gone = await exec('pulls', { pr: '99999' }, { 'GET /repos/o/r/pulls/99999': { status: 404, body: {} } });
  assert.equal(gone.verdict.verdict, 'absent');
  const denied = await exec('pulls', { pr: '1' }, { 'GET /repos/o/r/pulls/1': { status: 403, body: { message: 'x' } } });
  assert.equal(denied.code, 1);
});

test('pulls: more pages than allowed is unreadable, not a silent cut', async () => {
  const full = Array.from({ length: 100 }, (_, n) => ({ ...fixture('pulls-open.json')[0], number: n }));
  const routes = {};
  for (const p of [1, 2]) routes[`GET /repos/o/r/pulls?state=open&per_page=100&page=${p}`] = { status: 200, body: full };
  const r = await exec('pulls', { 'max-pages': '2' }, routes);
  assert.equal(r.code, 1);
  assert.match(r.log, /more than 2 pages/);
});

test('runs: filters by sha and reduces the recorded response', async () => {
  const body = fixture('runs.json');
  const r = await exec('runs', { workflow: 'ci.yml', sha: S, event: 'pull_request' },
    { [`GET /repos/o/r/actions/workflows/ci.yml/runs?head_sha=${S}&event=pull_request&per_page=100&page=1`]: { status: 200, body } });
  assert.equal(r.verdict.runs.length, 3);
  assert.deepEqual(Object.keys(r.verdict.runs[0]).sort(), ['actor', 'attempt', 'conclusion', 'created_at', 'event', 'head_branch', 'head_sha', 'id', 'status']);
});

test('runners: counts online, busy and idle per label from the org list', async () => {
  const r = await exec('runners', { labels: 'crusible-host,crusible-ci-k8s,none' }, { 'GET /orgs/o/actions/runners?per_page=100&page=1': { status: 200, body: fixture('runners-synthetic.json') } });
  assert.equal(r.verdict.total, 4);
  assert.equal(r.verdict.online, 3);
  assert.deepEqual(r.verdict.by_label['crusible-host'], { total: 3, online: 2, busy: 1, idle: 1 });
  assert.deepEqual(r.verdict.by_label['crusible-ci-k8s'], { total: 1, online: 1, busy: 0, idle: 1 });
  assert.equal(r.verdict.by_label.none.total, 0);
  const repo = await exec('runners', { scope: 'repo' }, { 'GET /repos/o/r/actions/runners?per_page=100&page=1': { status: 200, body: { runners: [] } } });
  assert.equal(repo.verdict.total, 0);
});

test('runners: administration read missing (403) fails closed', async () => {
  const r = await exec('runners', {}, { 'GET /orgs/o/actions/runners?per_page=100&page=1': { status: 403, body: { message: 'Resource not accessible by integration' } } });
  assert.equal(r.code, 1);
  assert.equal(r.verdict.verdict, 'unreadable');
});
