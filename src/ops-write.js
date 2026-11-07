// Write operations: status, label, dispatch.
import { Unreadable } from './api.js';
import { list } from './io.js';

export const GATES_MAX = 4096;
const STATES = ['pending', 'success', 'failure', 'error'];

export async function status(api, i, { sleep }) {
  if (!i.sha || !i.context) throw new Unreadable('status needs sha and context');
  if (!i.state) {
    // read: latest state of one context at sha, optionally waiting
    const waitMs = Number(i['wait-seconds'] || 0) * 1000;
    const step = waitMs > 0 ? waitMs / 3 : 0;
    for (let waited = 0; ; waited += step) {
      const d = await api.read(`/repos/${i.repository}/commits/${i.sha}/status`, { query: { per_page: 100 } });
      const hit = d?.statuses?.find((s) => s.context === i.context);
      if (hit) return { verdict: 'ok', state: hit.state, description: hit.description ?? '', ok: true };
      if (waited + step > waitMs || step === 0) return { verdict: 'absent', ok: false };
      await sleep(step);
    }
  }
  if (!STATES.includes(i.state)) throw new Unreadable(`bad state: ${i.state}`);
  const body = { state: i.state, context: i.context, description: (i.description ?? '').slice(0, 140) };
  if (i['target-url']) body.target_url = i['target-url'];
  const r = await api.request('POST', `/repos/${i.repository}/statuses/${i.sha}`, { body });
  if (r.status !== 201) throw new Unreadable(`status POST: HTTP ${r.status} ${r.data?.message ?? ''}`);
  return { verdict: 'ok', state: i.state, ok: true };
}

export async function label(api, i) {
  if (!i.pr) throw new Unreadable('label needs pr');
  const add = list(i.labels ?? '');
  const remove = list(i['remove-labels'] ?? '');
  if (!add.length && !remove.length) throw new Unreadable('label needs labels or remove-labels');
  if (add.length) {
    const r = await api.request('POST', `/repos/${i.repository}/issues/${i.pr}/labels`, { body: { labels: add } });
    if (r.status >= 300) throw new Unreadable(`label add: HTTP ${r.status} ${r.data?.message ?? ''}`);
  }
  for (const l of remove) {
    const r = await api.request('DELETE', `/repos/${i.repository}/issues/${i.pr}/labels/${encodeURIComponent(l)}`);
    if (r.status >= 300 && r.status !== 404) throw new Unreadable(`label remove ${l}: HTTP ${r.status}`);
  }
  return { verdict: 'ok', added: add, removed: remove, ok: true };
}

function unexpected(msg) {
  const m = /Unexpected inputs provided: \[([^\]]*)\]/.exec(msg ?? '');
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}

export async function dispatch(api, i, { log }) {
  if (!i.workflow || !i.ref) throw new Unreadable('dispatch needs workflow and ref');
  const inputs = i.inputs ? JSON.parse(i.inputs) : {};
  if (i.pr) inputs.pr = String(i.pr);
  if (i.gates) {
    if (Buffer.byteLength(i.gates) > GATES_MAX) throw new Unreadable(`gates above ${GATES_MAX} bytes refused`);
    inputs.gates = i.gates;
  }
  const dropped = [];
  for (;;) {
    const r = await api.request('POST', `/repos/${i.repository}/actions/workflows/${encodeURIComponent(i.workflow)}/dispatches`, { body: { ref: i.ref, inputs } });
    if (r.status === 204) return { verdict: 'ok', dropped, ok: true };
    const names = r.status === 422 ? unexpected(r.data?.message).filter((n) => n in inputs) : [];
    if (names.length && i['retry-unknown-inputs'] !== 'false' && !dropped.length) {
      for (const n of names) delete inputs[n];
      dropped.push(...names);
      log(`::warning::dispatch retried once without unknown inputs: ${names.join(',')}`);
      continue;
    }
    throw new Unreadable(`dispatch: HTTP ${r.status} ${r.data?.message ?? ''}`);
  }
}
