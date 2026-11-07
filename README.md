# Forge

A GitHub Action that decides, per pull request, whether your heavy CI workflow runs now, waits, or is skipped, and dispatches it when it should run.
The decision comes from three things you control: a **CI mode** (a repo variable), **bypass labels**, and **per-label caps**.

- One small job on `pull_request`. Your heavy workflow is started with `workflow_dispatch` at the pull request head.
- No clone of your repository. No secret, no personal access token: the job's `GITHUB_TOKEN` only.
- Draft pull requests never dispatch. Fork pull requests are skipped.
- Every decision is written to the job summary and to outputs.

## Quick start

```yaml
name: forge
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, labeled, unlabeled]
concurrency: { group: 'forge-${{ github.event.pull_request.number }}', cancel-in-progress: true }
permissions: { actions: write, pull-requests: read, contents: read }
jobs:
  forge:
    runs-on: ubuntu-latest
    steps:
      - uses: crusiblehq/forge-action@v1 # prefer the full commit SHA, see "Pinning"
        with: { workflow: ci.yml, mode: '${{ vars.CI_MODE }}', token: '${{ github.token }}' }
```

Your heavy workflow needs the dispatch trigger. The `pr` and `failfast` inputs are sent by default and may be renamed or switched off:

```yaml
on:
  workflow_dispatch:
    inputs:
      pr: { type: string }
      failfast: { type: string }
```

## Our configuration

All six modes enabled (the default), a bypass for pod 0 urgent work, and caps from a repository variable:

```yaml
- uses: crusiblehq/forge-action@v1
  with:
    workflow: ci.yml
    token: ${{ github.token }}
    mode: ${{ vars.CI_MODE }}
    bypass-labels: pod:crusible-dev-0+priority:urgent
    limit-by-label: ${{ vars.CI_LIMIT_BY_LABEL }}
    failfast-modes: SLOW_AHEAD
```

`vars.CI_LIMIT_BY_LABEL` holds:

```json
[
  { "label": "pod:crusible-dev-0", "modes": { "HALF_AHEAD": 10, "SLOW_AHEAD": 6, "DEAD_SLOW": 3 } },
  { "label": "pod:*", "modes": { "HALF_AHEAD": 6, "SLOW_AHEAD": 3, "DEAD_SLOW": 1 } }
]
```

## Modes

| Mode       | Dispatches               | failfast (default) |
| ---------- | ------------------------ | ------------------ |
| FULL_AHEAD | yes                      | no                 |
| HALF_AHEAD | yes                      | no                 |
| SLOW_AHEAD | yes                      | yes                |
| DEAD_SLOW  | yes                      | no                 |
| STANDBY    | only with a bypass label | n/a                |
| STOP       | never, bypass included   | n/a                |

- An unset variable is `FULL_AHEAD`. An unknown value is `SLOW_AHEAD` with a warning. The legacy `GREEN` and `YELLOW` map to `FULL_AHEAD` and `SLOW_AHEAD`.
- `enabled-modes` lists the modes you use. A variable value outside the list **fails safe** to the nearest more restrictive enabled mode, and warns. With only `FULL_AHEAD,STOP` enabled, `STANDBY` runs as `STOP`.
- A mode change applies to the next pull request event. It does not re-evaluate held pull requests; push, relabel or re-run the job.

## Bypass labels

`bypass-labels` lets a pull request through `STANDBY` and past the caps. A comma means OR. A plus means AND inside an entry. Matching is exact and case-sensitive. `STOP` still blocks.

```
priority:urgent                                      any urgent pull request
pod:crusible-dev-0+priority:urgent                   pod 0 AND urgent
pod:crusible-dev-0+priority:urgent,priority:blocker  either entry
```

A label name containing `,` or `+` cannot be used.

## Caps: `limit-by-label`

A JSON array, from a repository variable. Each entry gives a label (an exact name, or a glob with `*`) and, per mode, the most **ready** (open, non-draft) pull requests allowed to carry the same label value.

- The first entry that matches any of the pull request's labels is its rule, so write specific entries before globs.
- Each matching label value is its own bucket: `pod:a` and `pod:b` have separate counts under one `pod:*` entry.
- A mode missing from `modes` is uncapped. A pull request with no matching label is uncapped.
- The count is **one GraphQL read** per bucket at dispatch time (`pullRequests(states: OPEN, labels: [...])`, paged up to 500, drafts filtered out). Bypassing pull requests are not counted.
- Pull requests rank by number, lowest first. The lowest `cap` numbers are admitted. Two pull requests readied together resolve the same way in both jobs: the lower number is admitted and the higher is held, because each job reads the live list (GraphQL, not the search index) and ranks by number.
- The cap bounds per event; it is not a lock. Two jobs that read before each other's write can admit cap+1 until the next event re-ranks.
- A count that cannot be read (after two retries) **holds** the pull request (`on-count-error: hold`, the default). A rate limit (429, or a 403 with `x-ratelimit-remaining: 0` or `retry-after`) retries and then holds. A permission refusal (401, 403, 404, 422, GraphQL `FORBIDDEN`) fails the step at once and names the missing permission.
- This pull request is always counted as itself, even if the read omits it. More than 500 ready pull requests under one label hold (`cap-read-failed`).

## Operations (`op`)

Set `op` to run one GitHub operation instead of the gate. The token is the single `token` input; the action never mints or prints it.
Write ops: `status` (write or read a commit status), `label` (add and remove PR labels), `dispatch` (workflow dispatch with `pr` and `gates`;
a 422 naming unexpected inputs redispatches once without them).
Read ops: `files`, `ref`, `commit`, `tree`, `blob` (deduped by sha, 8 in flight), `pulls`, `runs`, `runners`, `pr-state` (state, expected head, 5-read mergeable, reused verdict, changed files: `closed|superseded|reused|conflict|ok`), `dispatch-pin` (the dispatch target's tip must equal the expected `sha`; refuses otherwise), `body-text` (title and body written under `dest`, never to an output), `lane-last-green` (12-hex sha per lane over the newest `max-runs` runs; absent lanes are `missing`, not never-green; it scans completed `push` runs, so a lane green inside a failed or cancelled run counts as green, and a failed jobs read on any scanned run fails the whole op) and `run-jobs`. `pr-state` exits 0 for `closed`, `superseded`, `conflict` and `reused`: callers MUST gate on `outputs.ok == 'true'`, not on step success. A read that is incomplete fails;
paths cannot leave `dest` or touch `.git`; one file is at most 1 MiB. Each sets the outputs `verdict` (JSON) and `ok`.
5xx, 429 and secondary rate limits retry with `Retry-After`; a 4xx is never retried; a run stops after 250 API calls.

## Known limits in v1

- **Held-label release is not built.** `held-label` marks a held pull request and clears on dispatch, but a `closed`, `converted_to_draft` or `unlabeled` event does not dispatch the lowest held pull request (SPEC 3.2.5). A held pull request runs on its next event: push, relabel or ready.
- **A re-run replays the original event payload.** Labels, draft state and head SHA come from the event as it was when it fired. A bypass label added after the event is not seen by a re-run, and a pull request converted to draft afterwards can still dispatch. Trigger a new event (`labeled`, `synchronize`) instead.
- **`runs-on-input` defaults to empty** where SPEC 1.3 names `runs_on`: an unknown dispatch input is a 422, so nothing is sent unless asked. Recorded as a spec amendment.
- **Dependabot npm PRs fail `check-dist`** until `dist/` is rebuilt on the branch.

## Inputs

| Input              | Default            | Meaning                                                                  |
| ------------------ | ------------------ | ------------------------------------------------------------------------ |
| `workflow`         | required           | Workflow file name or id to dispatch                                     |
| `mode`             | empty (FULL_AHEAD) | Pass `${{ vars.CI_MODE }}`                                               |
| `enabled-modes`    | all six            | Comma list of modes in use, case-insensitive; empty is an error          |
| `bypass-labels`    | empty              | `,` OR, `+` AND                                                          |
| `limit-by-label`   | empty              | JSON caps; pass `${{ vars.CI_LIMIT_BY_LABEL }}`                          |
| `on-count-error`   | `hold`             | `hold` or `dispatch` when the count cannot be read                       |
| `ref`              | PR head branch     | Ref to dispatch; the moved-head check always uses the PR head branch     |
| `dispatch-inputs`  | `{}`               | JSON merged into the dispatch inputs                                     |
| `pr-input`         | `pr`               | Dispatch input that receives the PR number; empty = not sent             |
| `failfast-input`   | `failfast`         | Dispatch input that receives `true`/`false`; empty = not sent            |
| `failfast-modes`   | `SLOW_AHEAD`       | Modes that set failfast                                                  |
| `runs-on-input`    | empty              | Dispatch input that receives the runner hint (JSON); empty = not sent    |
| `runs-on-default`  | empty              | Runner hint normally                                                     |
| `runs-on-overflow` | empty              | Runner hint in `DEAD_SLOW`                                               |
| `held-label`       | empty              | Label added on hold, removed on dispatch. Needs `pull-requests: write`   |
| `dedupe`           | `true`             | Skip when a dispatched run for this head SHA is queued, running or green |
| `dry-run`          | `false`            | Decide and report only                                                   |
| `token`            | required           | Pass the workflow GITHUB_TOKEN explicitly; there is no default           |

## Outputs

`decision` (`dispatch`, `hold`, `skip`), `reason`, `mode`, `bucket`, `ready-count`, `cap`, `rank`, `privileged`, `dispatched`, `failfast`, `runs-on`, `head-sha`, `held-label`.

## Permissions

Least privilege:

```yaml
permissions:
  actions: write # create the workflow_dispatch and list runs for the dedupe
  pull-requests: read # the ready count; `write` only if held-label is set
  contents: read # the head-branch tip check (git.getRef); a private repository returns 404 without it
```

Without `contents: read` a private repository answers the branch read with 404 and the step fails naming the permission. The mode and cap variables are read by GitHub before the job starts (`vars` context), which is why they arrive as inputs: the job token cannot read the variables API.

## Pinning

Moving tags can be re-pointed. Pin the full commit SHA with the version in a comment, and verify the bundle:

```yaml
- uses: crusiblehq/forge-action@<40-char-sha> # v1.0.0
```

```sh
gh attestation verify dist/index.js --repo crusiblehq/forge-action
```

Releases are immutable and carry build provenance. `v1` follows the latest `1.x.y`.

### Releasing

1. Set `version` in `package.json` to `X.Y.Z` and merge to `main`.
2. Create the release `vX.Y.Z` on a `main` commit. Prereleases are skipped.
3. Approve the run in the `release` environment.
4. `release.yml` rebuilds and verifies `dist/`, attests it, publishes `@crusiblehq/forge-action` to npm by trusted publishing (OIDC, with provenance, no stored token), and moves `v1`.

The first OIDC publish validates the npm trusted publisher, which is pending validation. It MUST happen before 2026-11-07 01:27 UTC.

## Development

`npm run all` formats, lints, typechecks, tests with coverage and rebuilds `dist/`. `dist/` is committed and the `check-dist` workflow fails when it is stale. See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/BEST-PRACTICES.md](docs/BEST-PRACTICES.md).

The policy logic lives apart from the GitHub calls: `src/policy/` is pure (modes, bypass, caps, decision) and has no I/O. It is written to be published later as a package of its own, `@crusiblehq/forge-policy`, so other tools can share the same rules. In v1 it is part of this repository.

## License

Apache-2.0. See [LICENSE](LICENSE).
