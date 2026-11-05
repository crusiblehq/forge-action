# Best practices adopted

Template files (`action.yml`, `package.json`, `check-dist.yml` of actions/typescript-action) were fetched on 2026-11-05. The GitHub docs pages are cited by title and were not re-fetched; re-check them at the next release. Everything listed is done in this repository unless it sits under "Not adopted".

## Runtime and layout

- **`runs.using: node24`**, `main: dist/index.js`, `engines.node >=24`. Source: [actions/typescript-action `action.yml`](https://github.com/actions/typescript-action/blob/main/action.yml) (checked: it uses `node24`).
- **TypeScript, a committed bundle, no `node_modules` at run time.** Source: [Creating a JavaScript action](https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-javascript-action), [actions/typescript-action](https://github.com/actions/typescript-action). The template bundles with rollup; so do we (`rollup.config.ts`).
- **`@actions/core` and `@actions/github`** for inputs, outputs, annotations, the summary and Octokit. Source: [actions/toolkit](https://github.com/actions/toolkit).
- **Pure core, thin I/O shell.** `src/policy/` has no I/O; `src/github.ts` is the narrow Octokit slice; `src/run.ts` takes both as dependencies. Tests drive `run()` without the Actions runtime. Pattern from the template's `main.ts`/`run()` split.
- **Typed, validated inputs with defaults, `required: true` only for `workflow`, branding in `action.yml`.** Source: [Metadata syntax for GitHub Actions](https://docs.github.com/en/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions).
- **Failure via `core.setFailed`**, never a thrown crash; config errors name the fix.
- **Job summary for every decision** (`core.summary`), as `actions/toolkit` documents.

## Repository CI

- **`check-dist` workflow:** rebuild and fail when `dist/` differs. Source: [typescript-action `check-dist.yml`](https://github.com/actions/typescript-action/blob/main/.github/workflows/check-dist.yml).
- **Tests, lint, format, typecheck** in one workflow with `node-version-file` and npm caching, as `actions/setup-node` recommends. `npm ci`, never `npm install`.
- **CodeQL** on pull requests, pushes and weekly. Source: typescript-action `codeql-analysis.yml`.
- **Dependabot** for `npm` and `github-actions`. Source: [Keeping your actions up to date with Dependabot](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot).
- Coverage threshold of 90% on the policy module is enforced by vitest, not a badge.

## Security

- **Every third-party action pinned to a full commit SHA** with a version comment. Source: [Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions), "Using third-party actions".
- **Least-privilege `permissions`** at workflow and job level; `persist-credentials: false` on `actions/checkout` except where the release job pushes a tag. Source: same guide, [actions/checkout](https://github.com/actions/checkout).
- **No expression interpolation into `run:`.** The release tag arrives through `env:`. Source: same guide, "Understanding the risk of script injections". The action itself reads event data as payload fields, not shell strings.
- **Build provenance** for `dist/index.js` with `actions/attest-build-provenance`; consumers verify with `gh attestation verify`. Source: [Artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations).
- **SECURITY.md** with private reporting.

## Releases and versioning

- **Semantic versions, a floating major tag (`v1`)** moved by the release workflow. Source: [Releasing and maintaining actions](https://docs.github.com/en/actions/sharing-automations/creating-actions/releasing-and-maintaining-actions), [actions/toolkit versioning](https://github.com/actions/toolkit/blob/main/docs/action-versioning.md).
- **Immutable releases** are enabled on the repository, so a published `vX.Y.Z` tag and its assets cannot be altered. The floating major tag is a plain tag and is not immutable; the README tells consumers to pin the SHA. Source: [Immutable releases](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases).
- **A protected `release` environment** with a required reviewer gates the workflow that moves the tag.

## Not adopted

- `actions/github-script` style inline scripts: harder to test and version than a bundle (the reference pr-dispatch workflow used one; this action replaces it).
- A composite action: shells out, needs `gh`/`jq` on the runner, and invites injection through `${{ }}` in `run:`.
- `@vercel/ncc`: the template moved to rollup; ESM-only `@actions/*` v3 bundles cleanly there.
