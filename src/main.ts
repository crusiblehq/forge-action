import * as core from '@actions/core'
import * as github from '@actions/github'
import type { Gh } from './github.js'
import { PolicyError } from './policy/index.js'
import { run, summaryRows, type Inputs, type PullRequestPayload } from './run.js'

async function main(): Promise<void> {
  const pr = github.context.payload.pull_request as PullRequestPayload | undefined
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
