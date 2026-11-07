# forge-action

GitHub operations for Crusible's `pr-dispatch`. Public repository: no secret or policy lives here.

One `op` per step. `token` is required and is whatever the caller supplies (job token or App installation token). The action never mints a token and never prints it: it is masked at start and scrubbed from errors.

Every op: 3 retries on 5xx and secondary rate limits (honouring `Retry-After`), none on 4xx, a budget of 250 API calls per step. A read it cannot complete is `unreadable`: the step fails (fail closed). Outputs: `verdict` (JSON, always has `verdict` = `ok`, `absent` or `unreadable`) and `ok`.

Pin by 40-character sha: `uses: crusiblehq/forge-action@<sha> # v1.x.y`.

## Ops

| op | inputs | verdict fields |
| --- | --- | --- |
| `status` write | `sha`, `context`, `state` (`pending` `success` `failure` `error`), `description`, `target-url` | `state` |
| `status` read (empty `state`) | `sha`, `context`, `wait-seconds` (three equal steps) | `state`, `description`; `absent` if none |
| `label` | `pr`, `labels`, `remove-labels` (404 on remove is fine) | `added`, `removed` |
| `dispatch` | `workflow`, `ref`, `pr`, `inputs` (JSON), `gates` (at most 4096 bytes, refused before the call), `retry-unknown-inputs` | `dropped`: inputs removed by the one retry |
| `files` | `paths`, `sha` or `ref`, `dest` | `files[]`: `path`, `found`, `size`, `sha` |
| `ref` | `ref` (`main`, `heads/x` or `tags/x`) | `sha`, `type`; `absent` on 404 |

`dispatch` on a 422 that names unexpected inputs (an old branch whose workflow lacks `gates`) redispatches once without them and logs a warning. Any other 422 fails with GitHub's message.

`files` reads the contents API per file. It rejects `..`, absolute paths and any `.git` segment before any call, caps a file at 1 MiB, and writes only under `dest`. There is no tarball op and no clone.

## Development

`npm ci`, `npm test` (node:test, fixtures in `test/fixtures` are recorded from the public API), `npm run build` (esbuild to `dist/index.js`, committed; CI fails on a stale `dist/`).
