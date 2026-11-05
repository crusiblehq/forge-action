# Contributing

1. Use Node 24 (`.node-version`). `npm ci`.
2. Change `src/`. Policy rules go in `src/policy/` (pure, no I/O); GitHub calls go in `src/github.ts`.
3. `npm run all` formats, lints, typechecks, tests with coverage (the policy module needs 90% or more) and rebuilds `dist/`.
4. Commit `dist/` with the source. The `check-dist` workflow fails when it is stale.
5. Use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`). Do not rewrite pushed history.
6. Pin any new workflow action to a full commit SHA with a version comment.
7. A new or changed input needs `action.yml`, the README table and a test in the same pull request.

Releases are created by a maintainer. The `release` workflow rebuilds `dist/`, attests it and moves the major tag.
