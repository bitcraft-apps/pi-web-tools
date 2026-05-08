# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's
[private vulnerability reporting](https://github.com/bitcraft-apps/pi-web-tools/security/advisories/new).
Do not open public issues for suspected vulnerabilities.

## Past advisories

- #60 — `url-guard`: block RFC1918, CGNAT, IPv6 ULA/link-local, and alternate IP encodings.
- #61 — `webfetch`: re-validate URL on every redirect hop.
- #62 — `webfetch`: enforce `MAX_RESPONSE_BYTES` at read time, not via `Content-Length`.
- #64 — `webfetch`: re-check resolved IP at connect time to close the DNS-rebinding gap.

These shipped to `main` but were originally typed `security:`, which
release-please ignores. They were re-released via a `fix(security):` commit;
see #70. PR title linting (#72) prevents a recurrence.
