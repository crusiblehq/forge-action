import test from 'node:test';
import assert from 'node:assert/strict';
import { exec, fixture } from './helpers.js';

const S = '732b68254b3cb32a689fb9f189872fef2bca6434';

test('status writes and never prints the token', async () => {
  const r = await exec('status', { sha: S, context: 'ci-route', state: 'success', description: 'pool=host' },
    { [`POST /repos/o/r/statuses/${S}`]: { status: 201, body: {} } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls[0].body, { state: 'success', context: 'ci-route', description: 'pool=host' });
  assert.equal(r.calls[0].auth, 'Bearer tok_SECRET');
  assert.match(r.log, /::add-mask::tok_SECRET/);
  assert.doesNotMatch(r.log.replace('::add-mask::tok_SECRET', ''), /tok_SECRET/);
  assert.doesNotMatch(r.outputs, /tok_SECRET/);
});

test('status rejects a bad state and surfaces 403', async () => {
  const bad = await exec('status', { sha: S, context: 'c', state: 'green' }, {});
  assert.equal(bad.code, 1);
  const r = await exec('status', { sha: S, context: 'c', state: 'success' },
    { [`POST /repos/o/r/statuses/${S}`]: { status: 403, body: { message: 'forbidden tok_SECRET' } } });
  assert.equal(r.code, 1);
  assert.equal(r.verdict.verdict, 'unreadable');
  assert.doesNotMatch(r.log.replace('::add-mask::tok_SECRET', ''), /tok_SECRET/);
  assert.equal(r.calls.length, 1, '4xx is not retried');
});

test('status read: hit, absent, and wait polls then gives up', async () => {
  const key = `GET /repos/o/r/commits/${S}/status?per_page=100`;
  const hit = await exec('status', { sha: S, context: 'ci-route' },
    { [key]: { status: 200, body: { statuses: [{ context: 'ci-route', state: 'success', description: 'pool=arc' }] } } });
  assert.equal(hit.verdict.description, 'pool=arc');
  const none = fixture('combined-status.json');
  const miss = await exec('status', { sha: S, context: 'ci-route', 'wait-seconds': '45' }, { [key]: { status: 200, body: none } });
  assert.equal(miss.verdict.verdict, 'absent');
  assert.equal(miss.calls.length, 4, 'reads at 0, 15, 30 and 45 s');
  const late = await exec('status', { sha: S, context: 'ci-route', 'wait-seconds': '45' },
    { [key]: [{ status: 200, body: none }, { status: 200, body: { statuses: [{ context: 'ci-route', state: 'success' }] } }] });
  assert.equal(late.verdict.verdict, 'ok');
  assert.equal(late.calls.length, 2);
});

test('label adds and removes; removing an absent label is fine', async () => {
  const r = await exec('label', { pr: '7', labels: 'ci:waiting-slot', 'remove-labels': 'old' }, {
    'POST /repos/o/r/issues/7/labels': { status: 200, body: [] },
    'DELETE /repos/o/r/issues/7/labels/old': { status: 404, body: {} },
  });
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls[0].body, { labels: ['ci:waiting-slot'] });
  assert.deepEqual(r.verdict.removed, ['old']);
});

test('dispatch sends ref and inputs; 204 is ok', async () => {
  const r = await exec('dispatch', { workflow: 'ci.yml', ref: 'feat-x', pr: '9', inputs: '{"lane":"ci"}', gates: '{"v":1}' },
    { 'POST /repos/o/r/actions/workflows/ci.yml/dispatches': { status: 204 } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls[0].body, { ref: 'feat-x', inputs: { lane: 'ci', pr: '9', gates: '{"v":1}' } });
});

test('dispatch refuses gates above 4096 bytes before any call', async () => {
  const r = await exec('dispatch', { workflow: 'ci.yml', ref: 'b', gates: 'x'.repeat(4097) }, {});
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
});

test('dispatch 422 naming gates redispatches once without it (B-1)', async () => {
  const k = 'POST /repos/o/r/actions/workflows/ci.yml/dispatches';
  const r = await exec('dispatch', { workflow: 'ci.yml', ref: 'old', pr: '9', gates: '{"v":1}' },
    { [k]: [{ status: 422, body: { message: 'Unexpected inputs provided: ["gates"]' } }, { status: 204 }] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.verdict.dropped, ['gates']);
  assert.deepEqual(r.calls[1].body.inputs, { pr: '9' });
  assert.match(r.log, /::warning::.*gates/);
});

test('dispatch 422 on another cause names the failure and does not retry', async () => {
  const k = 'POST /repos/o/r/actions/workflows/ci.yml/dispatches';
  const r = await exec('dispatch', { workflow: 'ci.yml', ref: 'b' }, { [k]: { status: 422, body: { message: 'Workflow does not have workflow_dispatch trigger' } } });
  assert.equal(r.code, 1);
  assert.match(r.log, /workflow_dispatch trigger/);
  assert.equal(r.calls.length, 1);
});

test('5xx is retried then unreadable; Retry-After honoured', async () => {
  const waits = [];
  const k = `POST /repos/o/r/statuses/${S}`;
  const bad = await exec('status', { sha: S, context: 'c', state: 'success' }, { [k]: { status: 502, body: {} } }, { wait: async (ms) => waits.push(ms) });
  assert.equal(bad.code, 1);
  assert.equal(bad.calls.length, 4);
  const rl = await exec('status', { sha: S, context: 'c', state: 'success' },
    { [k]: [{ status: 429, body: {}, headers: { 'retry-after': '7' } }, { status: 201, body: {} }] }, { wait: async (ms) => waits.push(ms) });
  assert.equal(rl.code, 0);
  assert.ok(waits.includes(7000));
});

test('missing token and unknown op fail closed', async () => {
  const r = await exec('nope', {}, {});
  assert.equal(r.code, 1);
  assert.match(r.log, /unknown op/);
});
