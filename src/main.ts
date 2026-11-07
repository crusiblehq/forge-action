import { readFileSync } from 'node:fs'
import * as core from '@actions/core'
import * as github from '@actions/github'
import type { Gh } from './github.js'
import { PolicyError } from './policy/index.js'
import { execOp } from './ops/index.js'
import { run, summaryRows, type Inputs, type PullRequestPayload } from './run.js'

// Test seam: the runner owns GITHUB_EVENT_PATH, so a self-test names its mocked event here instead.
function eventPayload(path: string): { pull_request?: unknown } {
  if (!path) return github.context.payload as { pull_request?: unknown }
  return JSON.parse(readFileSync(path, 'utf8')) as { pull_request?: unknown }
}

async function main(): Promise<void> {
  // `op` selects an operation; empty keeps the gate-and-dispatch mode below.
  if (core.getInput('op')) {
    process.exitCode = await execOp({
      get: (n) => core.getInput(n),
      repository: process.env.GITHUB_REPOSITORY ?? '',
      mask: (v) => v && core.setSecret(v),
      output: (n, v) => core.setOutput(n, v),
      error: (m) => core.error(m),
      log: (l) => core.info(l)
    })
    return
  }
  const payload = eventPayload(core.getInput('event-path'))
  const pr = payload.pull_request as PullRequestPayload | undefined
  if (!pr) throw new PolicyError(`needs a pull_request event, got "${github.context.eventName}"`)
  const gh = github.getOctokit(core.getInput('token', { required: true })) as unknown as Gh
  const inputs: Inputs = {
    mode: core.getInput('mode'),
    enabledModes: core.getInput('enabled-modes'),
    bypassLabels: core.getInput('bypass-labels'),
    limitByLabel: core.getInput('limit-by-label'),
    workflow: core.getInput('workflow', { required: true }),
    ref: core.getInput('ref'),
    dispatchInputs: core.getInput('dispatch-inputs'),
    prInput: core.getInput('pr-input'),
    failfastInput: core.getInput('failfast-input'),
    runsOnInput: core.getInput('runs-on-input'),
    failfastModes: core.getInput('failfast-modes'),
    runsOnDefault: core.getInput('runs-on-default'),
    runsOnOverflow: core.getInput('runs-on-overflow'),
    onCountError: core.getInput('on-count-error') || 'hold',
    heldLabel: core.getInput('held-label'),
    dedupe: core.getBooleanInput('dedupe'),
    dryRun: core.getBooleanInput('dry-run')
  }
  const r = await run({
    gh,
    repo: github.context.repo,
    pr,
    inputs,
    warn: core.warning,
    info: core.info,
    sleep: (ms) => new Promise((res) => setTimeout(res, ms))
  })
  core.setOutput('decision', r.decision)
  core.setOutput('reason', r.reason)
  core.setOutput('mode', r.mode)
  core.setOutput('bucket', r.bucket)
  core.setOutput('ready-count', r.count)
  core.setOutput('cap', r.cap < 0 ? '' : r.cap)
  core.setOutput('privileged', r.privileged)
  core.setOutput('dispatched', r.dispatched)
  core.setOutput('failfast', r.failfast)
  core.setOutput('runs-on', r.runsOn)
  core.setOutput('rank', r.rank)
  core.setOutput('head-sha', r.headSha)
  core.setOutput('held-label', r.heldLabel)
  core.info(`${r.decision}: ${r.reason}`)
  await core.summary
    .addHeading('Forge decision', 3)
    .addTable([
      [
        { data: 'Field', header: true },
        { data: 'Value', header: true }
      ],
      ...summaryRows(r, pr.number, inputs.dryRun)
    ])
    .write()
}

main().catch((err: unknown) => core.setFailed(err instanceof Error ? err.message : String(err)))
