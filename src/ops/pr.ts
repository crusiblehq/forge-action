// Pull request ops: pr-state, dispatch-pin, body-text. Each reads the live pull request; none writes.
import { Unreadable, type Api } from './api.js'
import { pages } from './lists.js'
import { SHA, type OpDeps, type OpInputs } from './shared.js'
import { writeUnder } from './safe.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
const READS = 5
const need = (cond: unknown, msg: string): void => {
  if (!cond) throw new Unreadable(msg)
}
const needPr = (i: OpInputs, op: string) => {
  need(i.pr, `${op} needs pr`)
  need(SHA.test(i.sha ?? ''), `${op} needs the expected 40-hex sha`)
}
const delay = (i: OpInputs) => {
  const s = Number(i['delay-seconds'] || 12)
  need(s <= 60, 'delay-seconds above the 60 s cap')
  return s * 1000
}
async function readPull(api: Api, i: OpInputs) {
  const d = await api.read(`/repos/${i.repository}/pulls/${i.pr}`)
  need(d, `pull request #${i.pr} not found`)
  return d
}
const facts = (d: any) => ({
  head_sha: d.head.sha,
  head_ref: d.head.ref,
  base_ref: d.base.ref,
  base_sha: d.base.sha,
  head_repo: d.head.repo?.full_name ?? null,
  author_id: d.user?.id ?? null
})
// REST spells the guard's CONFLICTING/DIRTY as mergeable=false / mergeable_state=dirty; null is still being computed.
const conflicting = (d: any) => d.mergeable === false || d.mergeable_state === 'dirty'

/** Newest ci-required status at the sha, scanning pages until it is found; a full last page with none is unreadable. */
async function ciRequired(api: Api, repo: string, sha: string) {
  const max = 3
  for (let page = 1; page <= max; page++) {
    const rows = await api.read(`/repos/${repo}/commits/${sha}/statuses`, { query: { per_page: 100, page } })
    need(Array.isArray(rows), `statuses of ${sha} unreadable`)
    const hit = rows.find((s: any) => s.context === 'ci-required')
    if (hit) return hit
    if (rows.length < 100) return null
  }
  throw new Unreadable(`statuses of ${sha}: ci-required not in the first ${max} pages`)
}

/** The run id whose green ci-required this head may reuse: a completed ci.yml dispatch of this pull request on exactly this sha. */
async function reusedRun(api: Api, i: OpInputs): Promise<number | null> {
  const s = await ciRequired(api, i.repository, i.sha!)
  if (s?.state !== 'success' || s.creator?.login !== 'github-actions[bot]') return null
  const m = new RegExp(`^https://github\\.com/${i.repository}/actions/runs/(\\d+)$`).exec(s.target_url ?? '')
  if (!m) return null
  const run = await api.read(`/repos/${i.repository}/actions/runs/${m[1]}`)
  need(run, `run ${m[1]} not found`)
  const ok =
    run.path === '.github/workflows/ci.yml' &&
    run.head_sha === i.sha &&
    run.event === 'workflow_dispatch' &&
    run.status === 'completed' &&
    String(run.display_title ?? '').startsWith(`CI PR #${i.pr} @`)
  return ok ? Number(m[1]) : null
}

// Verdict ok|closed|superseded|reused|conflict; any unread state throws (unreadable). sha is the head the caller tests.
export async function prState(api: Api, i: OpInputs, d: OpDeps) {
  needPr(i, 'pr-state')
  const wait = delay(i)
  let pull = await readPull(api, i)
  const out = (verdict: string, extra: object = {}) => ({
    verdict,
    pr: Number(i.pr),
    state: pull.merged ? 'merged' : pull.state,
    ...facts(pull),
    ...extra,
    ok: verdict === 'ok'
  })
  if (pull.state !== 'open') return out('closed')
  if (pull.head.sha !== i.sha) {
    await d.sleep(wait)
    pull = await readPull(api, i)
    if (pull.state !== 'open') return out('closed')
    if (pull.head.sha !== i.sha) return out('superseded', { expected_sha: i.sha })
  }
  const reused = await reusedRun(api, i)
  // a verdict answers for the base it was cut against: a retargeted pull request does not reuse it
  if (reused && (!i.base || i.base === pull.base.ref)) return out('reused', { run: reused })
  let reads = 0
  for (;;) {
    reads++
    if (!conflicting(pull)) break
    if (reads >= READS) return out('conflict', { reads })
    await d.sleep(wait)
    pull = await readPull(api, i)
    need(pull.head.sha === i.sha, `head moved to ${pull.head.sha} during the mergeable reads`)
  }
  const files = await pages(api, `/repos/${i.repository}/pulls/${i.pr}/files`, {}, null, 30)
  need(files.length === pull.changed_files, `changed files read ${files.length} of ${pull.changed_files}`)
  return out('ok', { reads, files: files.map((f) => ({ path: f.filename, status: f.status })) })
}

// The dispatch target's tip must be the sha the pass listed, which must be the pull request's head.
export async function dispatchPin(api: Api, i: OpInputs) {
  needPr(i, 'dispatch-pin')
  const pull = await readPull(api, i)
  need(pull.state === 'open', `pull request #${i.pr} is ${pull.state}`)
  need(pull.head.sha === i.sha, `pull request #${i.pr} head is ${pull.head.sha}, the pass listed ${i.sha}`)
  const ref = i.ref || pull.head.ref
  const name = /^heads\//.test(ref) ? ref : `heads/${ref}`
  const tip = await api.read(`/repos/${i.repository}/git/ref/${name.split('/').map(encodeURIComponent).join('/')}`)
  need(tip, `dispatch target ${name} does not exist in ${i.repository}`)
  need(tip.object.sha === i.sha, `dispatch target ${name} tip is ${tip.object.sha}, the pass listed ${i.sha}`)
  return { verdict: 'ok', ...facts(pull), ok: true }
}

// Live title and body. The body is attacker-controlled text: it goes to files under dest, never to an output or a log.
export async function bodyText(api: Api, i: OpInputs) {
  needPr(i, 'body-text')
  need(i.dest, 'body-text needs dest')
  const pull = await readPull(api, i)
  need(pull.head.sha === i.sha, `pull request #${i.pr} head is ${pull.head.sha}, the pass listed ${i.sha}`)
  const title: string = pull.title ?? ''
  const body: string = pull.body ?? ''
  writeUnder(i.dest!, 'title.txt', Buffer.from(title))
  writeUnder(i.dest!, 'body.md', Buffer.from(body))
  return { verdict: 'ok', title, title_chars: title.length, body_chars: body.length, ok: true }
}
