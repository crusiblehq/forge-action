# Security policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting: Security tab, "Report a vulnerability". Do not open a public issue. We acknowledge within 3 business days.

## Supported versions

The latest `1.x` release receives fixes. A breaking input change ships as `v2`.

## Design notes

- The action uses the job `GITHUB_TOKEN` only, with `actions: write` and `pull-requests: read`. It reads no secret and clones nothing.
- Event data (branch names, labels, titles) is read from the payload as data. It is never placed in a shell string.
- Fork pull requests are skipped. The job never runs fork code.
- Releases are immutable, carry build provenance for `dist/index.js`, and every workflow action here is pinned to a full commit SHA.
- Consumers should pin the full commit SHA, not the `v1` tag.
