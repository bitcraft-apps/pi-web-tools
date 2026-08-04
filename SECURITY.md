# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's
[private vulnerability reporting](https://github.com/bitcraft-apps/pi-web-tools/security/advisories/new).
Do not open public issues for suspected vulnerabilities.

## Dependency updates

Dependabot alerts are enabled for this repository.

Dependabot *security* updates are not available. This repository uses the `bun`
ecosystem, because the committed lockfile is `bun.lock`. GitHub lists security
updates as unsupported for that ecosystem. There are no out-of-band security
pull requests.

The compensating control is the weekly Dependabot version sweep. It picks up
patched releases like any other release. The worst-case delay between a patched
release and a pull request is one week.

The runtime dependency surface is one package: `undici`, declared as
`^6.0.0 || ^7.0.0 || ^8.0.0`. All other entries in `package.json` are peer
dependencies or development dependencies.

See [`.github/dependabot.yml`](./.github/dependabot.yml) for the reasoning, and
issue #179 for the history.

## Past advisories

- #60 — `url-guard`: block RFC1918, CGNAT, IPv6 ULA/link-local, and alternate IP encodings.
- #61 — `webfetch`: re-validate URL on every redirect hop.
- #62 — `webfetch`: enforce `MAX_RESPONSE_BYTES` at read time, not via `Content-Length`.
- #64 — `webfetch`: re-check resolved IP at connect time to close the DNS-rebinding gap.

These shipped to `main` but were originally typed `security:`, which
release-please ignores. They were re-released via a `fix(security):` commit;
see #70. PR title linting (#72) prevents a recurrence.
