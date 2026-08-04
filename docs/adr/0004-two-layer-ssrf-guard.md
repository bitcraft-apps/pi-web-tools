← [ADR index](README.md) · [README](../../README.md) · see also: [ADR 0003](0003-undici-own-fetch.md), [`SECURITY.md`](../../SECURITY.md)

# 0004. The SSRF guard is two layers: a string parse and a connect-time DNS pin

**Status:** Accepted
**Date:** 2026-08-04
**Issue:** [#56](https://github.com/bitcraft-apps/pi-web-tools/issues/56), [#57](https://github.com/bitcraft-apps/pi-web-tools/issues/57), [#64](https://github.com/bitcraft-apps/pi-web-tools/issues/64)

## Context

`webfetch` fetches an arbitrary URL that the model supplies, and both
[`README.md`](../../README.md) and the tool description in every prompt promise
it cannot reach localhost or RFC1918 addresses. That promise is the whole guard.

Three closed issues each closed a different hole in it, and each hole was
reachable while the other two were shut:

- **#56** — the blocklist matched a handful of literal strings. `10.0.0.1`,
  `[fc00::1]`, and every alternate encoding the URL parser accepts (decimal
  `2130706433`, octal `0177.0.0.1`, hex `0x7f.0.0.1`, bare `0`) all passed.
- **#57** — `redirect: "follow"` meant only the *input* URL was ever checked. A
  public host could answer `302 Location: http://169.254.169.254/latest/meta-data/`
  and Node's fetch followed it.
- **#64** — a public name whose A record points at `127.0.0.1` passes every
  string-level check there is, because no string-level check resolves DNS.

The fixes live in two files, and neither file can state the joint invariant on
its own. This record does.

## Decision

Guard SSRF in two layers. Each stops an attack the other structurally cannot
see.

**1. String-level parse and validation, before the request.** `validateUrl` in
`src/lib/url-guard.ts` runs on the input URL (`src/lib/pipeline.ts:149`), on
each alternate link (`src/lib/pipeline.ts:510`), and on **every redirect hop**
(`src/lib/http.ts:286`, reached because `doFetch` sets `redirect: "manual"` and
`fetchWithRedirects` walks the chain itself under a 5-hop cap — stricter than
fetch's default of 20). It enforces the `http:`/`https:` scheme allowlist,
rejects the empty-authority form, matches `BLOCKED_HOSTNAMES`, and normalizes IP
literals through its own WHATWG-faithful IPv4/IPv6 parsers before the range
check — including the deliberate divergence where a leading-zero part is read as
octal instead of failing, because failing would fall through to the DNS-name
branch and let `0177.0.0.1` past.

*Blind spot: it never resolves DNS.* For a name it cannot tell where the socket
will go.

**2. Connect-time DNS pin.** `getSsrfAgent` in `src/lib/ssrf-agent.ts` builds an
undici `Agent` whose connector gets a custom `lookup`. `ssrfLookup` calls
`dns.lookup`, re-runs the same range checks via `isBlockedAddress`, and either
hands the address to the connector or fails the lookup with an `EBLOCKED`
error — before any socket opens. The address validated *is* the address
connected to, so there is no rebinding window, and SNI/TLS still uses the
original hostname with no `Host`-header surgery. The `all: true` array form is
rejected if *any* answer is blocked, since undici may iterate the list across
families on connect failure.

*Blind spot: it only ever sees an IP address.* It cannot refuse a scheme or an
empty authority, and it is not invoked at all for IP-literal hosts, which bypass
DNS in `net.connect`.

**Neither layer is redundant.** Layer 1 cannot see a DNS rebind (#64). Layer 2
cannot refuse `file:` and never runs for `http://10.0.0.1` (#56). Delete either
one and a closed issue reopens. The detailed range tables and parser notes stay
in the two file headers; this record exists so the pair is not mistaken for
belt-and-braces.

## Consequences

**One range list, two callers.** `isBlockedAddress` is exported from
`url-guard.ts` and used by both layers, so adding a blocked range is a
single-place change.

**`isBlockedAddress` is fail-closed, which constrains reuse.** Input that parses
as neither IPv4 nor IPv6 returns `true` (blocked) — `isBlockedAddress("not-an-ip")`
is `true`. That is correct for a `dns.lookup` result and wrong for a
user-supplied hostname. The warning is spelled out at the function's header
comment; read it before calling from anywhere new.

**Layer 2 depends on the dispatcher being honored.** It reaches a request only
through the `dispatcher:` option, which is why the package calls the installed
undici's `fetch` rather than Node's global one. See [ADR 0003](0003-undici-own-fetch.md).

**The retry path re-walks from the original URL.** `src/lib/http.ts` retries a
rate-limited request against the input URL, not the post-redirect final URL, so
`validateUrl` runs on every hop again and a server cannot smuggle a blocked
target in through the retry.

**`requireSameOriginAs` is a third, narrower pin — not part of this decision.**
`fetchWithRedirects` accepts it so the alternate-link fallback can require every
hop to stay on the page's origin. `validateUrl` blocks private addresses, not
arbitrary public hosts, so the origin check is what stops a same-origin
alternate from 302-ing to an attacker.

**Coverage.** `test/url-guard.test.ts` (ranges and encodings),
`test/ssrf-agent.test.ts` (the lookup hook in isolation), and two blocks in
`test/pipeline.test.ts`: `redirect re-validation (issue #57)` for per-hop
checking and the hop cap, and `DNS-rebinding guard (issue #64)`, which asserts
the hook was actually called and so fails if the dispatcher is dropped.

## Alternatives rejected

**1. String blocklist alone.** The state before #64. Rejected: rebindable by
construction — the check inspects a name, the socket connects to an address, and
nothing ties the two together.

**2. Resolve the hostname, then hand the IP to `fetch`.** Option 1 in #64.
Rejected: it leaves a rebinding window between the validating lookup and the
connecting one, and passing an IP with a `Host` header breaks SNI/TLS.

**3. Check the peer address after connecting.** Option 3 in #64. Rejected as
useless — by then the internal service has been contacted.

**4. Connect-time pin alone, dropping `validateUrl`.** Rejected: it cannot
enforce the scheme allowlist or the empty-authority rule, and it never runs for
IP-literal hosts, which is the entire #56 attack set.

**5. `redirect: "follow"` with validation only on the input URL.** The state
before #57, and the highest-impact gap of the three: it bypassed the guard
regardless of how thorough the blocklist was.
