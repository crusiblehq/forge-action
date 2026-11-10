// Op mode: one GitHub operation per step on a caller-supplied token. Never mints or prints the token.
import { client, Unreadable, type Api, type ClientOpts } from './api.js'
import { scrub, validate, type OpDeps, type OpInputs } from './shared.js'
import * as g from './git.js'
import * as l from './lists.js'
import * as r from './read.js'
import * as c from './ci.js'
import * as p from './pr.js'
import * as w from './write.js'

export type Op = (api: Api, i: OpInputs, d: OpDeps) => Promise<{ verdict: string; ok: boolean }>
export const OPS: Record<string, Op> = {
  status: w.status,
  label: w.label,
  dispatch: w.dispatch,
  files: r.files,
  ref: r.ref,
  commit: g.commit,
  tree: g.tree,
  blob: g.blob,
  pulls: l.pulls,
  runs: l.runs,
  runners: l.runners,
  'pr-state': p.prState,
  'dispatch-pin': p.dispatchPin,
  'body-text': p.bodyText,
  'lane-last-green': c.laneLastGreen,
  'run-jobs': c.runJobs
}

export const OP_INPUTS = [
  'op',
  'token',
  'repository',
  'pr',
  'sha',
  'ref',
  'paths',
  'dest',
  'state',
  'context',
  'description',
  'target-url',
  'labels',
  'remove-labels',
  'workflow',
  'inputs',
  'gates',
  'wait-seconds',
  'retry-unknown-inputs',
  'event',
  'status',
  'base',
  'recursive',
  'max-entries',
  'max-pages',
  'cache',
  'scope',
  'run',
  'attempt',
  'lanes',
  'max-runs',
  'delay-seconds',
  'unknown-wait-seconds',
  'dirty-reads',
  'reuse',
  'files',
  'rereads'
] as const

export interface OpEnv {
  get(name: string): string
  repository: string
  mask(v: string): void
  output(name: string, value: unknown): void
  error(msg: string): void
  log(line: string): void
  sleep?(ms: number): Promise<void>
  client?: Partial<ClientOpts>
}

/** Returns the process exit code. */
export async function execOp(env: OpEnv): Promise<number> {
  const i = Object.fromEntries(OP_INPUTS.map((n) => [n, env.get(n)])) as OpInputs
  env.mask(i.token!)
  try {
    if (!i.token) throw new Unreadable('token input is required')
    i.repository ||= env.repository
    validate(i)
    const op = OPS[i.op!]
    if (!op) throw new Unreadable(`unknown op: ${i.op}`)
    const api = client({ token: i.token, ...env.client })
    const res = await op(api, i, { sleep: env.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), log: env.log })
    env.output('verdict', JSON.stringify(res))
    env.output('ok', String(!!res.ok))
    return 0
  } catch (e) {
    const msg = scrub((e as Error).message, i.token ?? '')
    env.error(`${i.op || 'forge-action'}: ${msg}`)
    env.output('verdict', JSON.stringify({ verdict: 'unreadable', why: msg.slice(0, 200) }))
    env.output('ok', 'false')
    return 1
  }
}
