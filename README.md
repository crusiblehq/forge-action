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
    types: [opened, synchronize, reopened, ready_for_review]
concurrency: { group: 'forge-${{ github.event.pull_request.number }}', cancel-in-progress: true }
permissions: { actions: write, pull-requests: read }
jobs:
  forge:
    runs-on: ubuntu-latest
    steps:
      - uses: crusiblehq/forge-action@v1 # prefer the full commit SHA, see "Pinning"
        with: { workflow: ci.yml, mode: '${{ vars.CI_MODE }}' }
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
- The count is **one search call** per bucket at dispatch time. Bypassing pull requests are not counted.
- Pull requests rank by number, lowest first. The lowest `cap` numbers are admitted. Two pull requests readied together never both pass a cap of 1.
- The cap bounds per event; it is not a lock. Two jobs that read before each other's write can admit cap+1 until the next event re-ranks.
- A count that cannot be read (after two retries) **holds** the pull request (`on-count-error: hold`, the default). A 401, 403 or 404 fails the step at once and names the missing permission.
- The search API is an index and can lag by seconds; this pull request is always counted as itself.

## Inputs

| Input              | Default               | Meaning                                                                  |
| ------------------ | --------------------- | ------------------------------------------------------------------------ |
| `workflow`         | required              | Workflow file name or id to dispatch                                     |
| `mode`             | empty (FULL_AHEAD)    | Pass `${{ vars.CI_MODE }}`                                               |
| `enabled-modes`    | all six               | Comma list of modes in use                                               |
| `bypass-labels`    | empty                 | `,` OR, `+` AND                                                          |
| `limit-by-label`   | empty                 | JSON caps; pass `${{ vars.CI_LIMIT_BY_LABEL }}`                          |
| `on-count-error`   | `hold`                | `hold` or `dispatch` when the count cannot be read                       |
| `ref`              | PR head branch        | Ref to dispatch                                                          |
| `dispatch-inputs`  | `{}`                  | JSON merged into the dispatch inputs                                     |
| `pr-input`         | `pr`                  | Dispatch input that receives the PR number; empty = not sent             |
| `failfast-input`   | `failfast`            | Dispatch input that receives `true`/`false`; empty = not sent            |
| `failfast-modes`   | `SLOW_AHEAD`          | Modes that set failfast                                                  |
| `runs-on-input`    | empty                 | Dispatch input that receives the runner hint (JSON); empty = not sent    |
| `runs-on-default`  | empty                 | Runner hint normally                                                     |
| `runs-on-overflow` | empty                 | Runner hint in `DEAD_SLOW`                                               |
| `held-label`       | empty                 | Label added on hold, removed on dispatch. Needs `pull-requests: write`   |
| `dedupe`           | `true`                | Skip when a dispatched run for this head SHA is queued, running or green |
| `dry-run`          | `false`               | Decide and report only                                                   |
| `token`            | `${{ github.token }}` | Leave the default                                                        |

## Outputs

`decision` (`dispatch`, `hold`, `skip`), `reason`, `mode`, `bucket`, `count`, `cap`, `rank`, `privileged`, `dispatched`, `failfast`, `runs-on`, `head-sha`, `held-label`.

## Permissions

Least privilege:

```yaml
permissions:
  actions: write # create the workflow_dispatch and list runs for the dedupe
  pull-requests: read # the ready count; `write` only if held-label is set
```

`contents` is not needed. The mode and cap variables are read by GitHub before the job starts (`vars` context), which is why they arrive as inputs: the job token cannot read the variables API.

## Pinning

Moving tags can be re-pointed. Pin the full commit SHA with the version in a comment, and verify the bundle:

```yaml
- uses: crusiblehq/forge-action@<40-char-sha> # v1.0.0
```

```sh
gh attestation verify dist/index.js --repo crusiblehq/forge-action
```

Releases are immutable and carry build provenance. `v1` follows the latest `1.x.y`.

## Development

`npm run all` formats, lints, typechecks, tests with coverage and rebuilds `dist/`. `dist/` is committed and the `check-dist` workflow fails when it is stale. See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/BEST-PRACTICES.md](docs/BEST-PRACTICES.md).

The policy logic lives apart from the GitHub calls: `src/policy/` is pure (modes, bypass, caps, decision) and has no I/O. It is written to be published later as a package of its own, `@crusiblehq/forge-policy`, so other tools can share the same rules. In v1 it is part of this repository.

## License

Apache-2.0. See [LICENSE](LICENSE).
