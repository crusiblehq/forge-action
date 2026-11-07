// Actions ops: run-jobs, lane-last-green. Jobs are read to the last page; a count that disagrees with total_count fails.
import { Unreadable, type Api } from './api.js'
import { list, type OpInputs } from './shared.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
const LANE = /^[\w.-]+$/
function need(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Unreadable(msg)
}

async function jobsOf(api: Api, repo: string, id: number | string, attempt: number | string) {
  const path = `/repos/${repo}/actions/runs/${id}/attempts/${attempt}/jobs`
  const rows: any[] = []
  for (let page = 1; page <= 5; page++) {
    const d = await api.read(path, { query: { per_page: 100, page } })
    if (!d) return null
    rows.push(...d.jobs)
    if (rows.length >= d.total_count) return rows
    need(d.jobs.length === 100, `${path}: ${rows.length} of ${d.total_count} jobs`)
  }
  throw new Unreadable(`${path}: more than 5 pages of jobs`)
}

export async function runJobs(api: Api, i: OpInputs) {
  need(i.run, 'run-jobs needs run')
  const run = await api.read(`/repos/${i.repository}/actions/runs/${i.run}`)
  if (!run) return { verdict: 'absent', ok: false }
  const attempt = i.attempt || run.run_attempt
  const rows = await jobsOf(api, i.repository, i.run!, attempt)
  need(rows, `jobs of run ${i.run} attempt ${attempt} not found`)
  const jobs = rows.map((j) => ({
    id: j.id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    started_at: j.started_at,
    completed_at: j.completed_at,
    runner_name: j.runner_name
  }))
  // a run still going has no final conclusions: report it, do not pass it off as a result
  const done = run.status === 'completed'
  return {
    verdict: done ? 'ok' : 'incomplete',
    run: Number(i.run),
    attempt: Number(attempt),
    conclusion: run.conclusion,
    jobs,
    ok: done
  }
}

// `stage / lane` in a called workflow, or just the lane; a matrix suffix ` (…)` dropped.
const laneOf = (name: string) => {
  const bare = name.replace(/\s*\([^()]*\)\s*$/, '')
  return (bare.includes('/') ? bare.split('/').pop()! : bare).trim()
}

// Newest completed run first; a lane is green in a run only when every one of its jobs succeeded. A lane with no hit in the
// scanned runs is `missing`: "no record in N runs", never "never green".
export async function laneLastGreen(api: Api, i: OpInputs) {
  const lanes = list(i.lanes ?? '')
  need(lanes.length && lanes.length <= 24 && lanes.every((l) => LANE.test(l)), 'lane-last-green needs 1-24 lanes')
  const max = Number(i['max-runs'] || 30)
  need(max >= 1 && max <= 100, 'max-runs must be 1-100')
  const q: Record<string, string> = { status: 'completed', branch: i.ref || 'main', event: i.event || 'push' }
  const wf = encodeURIComponent(i.workflow || 'ci.yml')
  const d = await api.read(`/repos/${i.repository}/actions/workflows/${wf}/runs`, {
    query: { ...q, per_page: Math.min(max, 100) }
  })
  need(d, `workflow ${i.workflow || 'ci.yml'} not found`)
  const runs: any[] = d.workflow_runs.slice(0, max)
  const found: Record<string, string> = {}
  let scanned = 0
  for (const run of runs) {
    if (lanes.every((l) => l in found)) break
    scanned++
    const jobs = await jobsOf(api, i.repository, run.id, run.run_attempt)
    need(jobs, `jobs of run ${run.id} not found`)
    const green = new Map<string, boolean>()
    for (const j of jobs) {
      const lane = laneOf(j.name)
      if (lanes.includes(lane) && !(lane in found))
        green.set(lane, (green.get(lane) ?? true) && j.conclusion === 'success')
    }
    for (const [lane, ok] of green) if (ok) found[lane] = run.head_sha.slice(0, 12)
  }
  return { verdict: 'ok', lanes: found, missing: lanes.filter((l) => !(l in found)), scanned, ok: true }
}
