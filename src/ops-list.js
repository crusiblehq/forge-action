// List reads: pulls, runs, runners. Reduced to the fields the pass uses.
import { Unreadable } from './api.js';
import { list } from './io.js';

async function pages(api, path, query, key, max) {
  const out = [];
  for (let page = 1; page <= max; page++) {
    const d = await api.read(path, { query: { ...query, per_page: 100, page } });
    if (!d) throw new Unreadable(`GET ${path}: not found`);
    const rows = key ? d[key] : d;
    out.push(...rows);
    if (rows.length < 100) return out;
  }
  throw new Unreadable(`GET ${path}: more than ${max} pages`);
}

const pr = (p) => ({ number: p.number, state: p.state, merged: !!p.merged, draft: p.draft, head_sha: p.head.sha, head_ref: p.head.ref, head_repo: p.head.repo?.full_name ?? null, base_ref: p.base.ref, mergeable: p.mergeable ?? null, mergeable_state: p.mergeable_state ?? null, labels: p.labels.map((l) => l.name) });

// `pr` reads one pull request (state, heads, mergeable); otherwise lists by `state` (open) and `base`.
export async function pulls(api, i) {
  if (i.pr) {
    const d = await api.read(`/repos/${i.repository}/pulls/${i.pr}`);
    return d ? { verdict: 'ok', pull: pr(d), ok: true } : { verdict: 'absent', ok: false };
  }
  const query = { state: i.state || 'open', ...(i.base ? { base: i.base } : {}) };
  const rows = await pages(api, `/repos/${i.repository}/pulls`, query, null, Number(i['max-pages'] || 5));
  return { verdict: 'ok', pulls: rows.map(pr), ok: true };
}

export async function runs(api, i) {
  const q = { ...(i.sha ? { head_sha: i.sha } : {}), ...(i.ref ? { branch: i.ref } : {}), ...(i.event ? { event: i.event } : {}), ...(i.status ? { status: i.status } : {}) };
  const path = i.workflow ? `/repos/${i.repository}/actions/workflows/${encodeURIComponent(i.workflow)}/runs` : `/repos/${i.repository}/actions/runs`;
  const rows = await pages(api, path, q, 'workflow_runs', Number(i['max-pages'] || 3));
  const out = rows.map((r) => ({ id: r.id, attempt: r.run_attempt, status: r.status, conclusion: r.conclusion, head_sha: r.head_sha, head_branch: r.head_branch, event: r.event, actor: r.actor?.login ?? null, created_at: r.created_at }));
  return { verdict: 'ok', runs: out, ok: true };
}

// scope=org (default) reads the owner's runners, scope=repo the repository's. `labels` selects the counted labels.
export async function runners(api, i) {
  const org = i.repository.split('/')[0];
  const path = i.scope === 'repo' ? `/repos/${i.repository}/actions/runners` : `/orgs/${org}/actions/runners`;
  const rows = await pages(api, path, {}, 'runners', Number(i['max-pages'] || 5));
  const tally = (rs) => ({ total: rs.length, online: rs.filter((r) => r.status === 'online').length, busy: rs.filter((r) => r.status === 'online' && r.busy).length, idle: rs.filter((r) => r.status === 'online' && !r.busy).length });
  const by_label = {};
  for (const l of list(i.labels ?? '')) by_label[l] = tally(rows.filter((r) => r.labels.some((x) => x.name === l)));
  return { verdict: 'ok', ...tally(rows), by_label, ok: true };
}
