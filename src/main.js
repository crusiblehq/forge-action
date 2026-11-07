// forge-action entry. One op per step; the token is only an input, never minted or printed.
import { client, Unreadable } from './api.js';
import { getInput, mask, setOutput, scrub } from './io.js';
import * as w from './ops-write.js';
import * as r from './ops-read.js';
import * as g from './ops-git.js';
import * as l from './ops-list.js';

export const OPS = { status: w.status, label: w.label, dispatch: w.dispatch, files: r.files, ref: r.ref, commit: g.commit, tree: g.tree, blob: g.blob, pulls: l.pulls, runs: l.runs, runners: l.runners };
const NAMES = ['op', 'token', 'repository', 'pr', 'sha', 'ref', 'paths', 'dest', 'state', 'context', 'description', 'target-url', 'labels', 'remove-labels', 'workflow', 'inputs', 'gates', 'wait-seconds', 'retry-unknown-inputs', 'event', 'status', 'base', 'recursive', 'max-entries', 'max-pages', 'cache', 'scope'];

export async function run(env = process.env, deps = {}) {
  const i = Object.fromEntries(NAMES.map((n) => [n, getInput(n, env)]));
  const out = deps.out ?? ((s) => process.stdout.write(s));
  mask(i.token, out);
  try {
    if (!i.token) throw new Unreadable('token input is required');
    i.repository ||= env.GITHUB_REPOSITORY ?? '';
    const op = OPS[i.op];
    if (!op) throw new Unreadable(`unknown op: ${i.op}`);
    const api = deps.api ?? client({ token: i.token, ...(deps.client ?? {}) });
    const res = await op(api, i, { sleep: deps.sleep ?? ((ms) => new Promise((x) => setTimeout(x, ms))), log: out });
    setOutput('verdict', res, env);
    setOutput('ok', String(!!res.ok), env);
    return 0;
  } catch (e) {
    const msg = scrub(e.message, i.token);
    out(`::error::${i.op || 'forge-action'}: ${msg}\n`);
    setOutput('verdict', { verdict: 'unreadable', why: msg.slice(0, 200) }, env);
    setOutput('ok', 'false', env);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.env.GITHUB_ACTION) {
  run().then((c) => { process.exitCode = c; });
}
