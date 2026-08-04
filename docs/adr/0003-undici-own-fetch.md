← [ADR index](README.md) · [README](../../README.md) · see also: [ADR 0002](0002-in-band-markers.md), [`SECURITY.md`](../../SECURITY.md)

# 0003. `webfetch` calls undici's own `fetch`, not Node's global `fetch`

**Status:** Accepted
**Date:** 2026-08-04
**Issue:** [#166](https://github.com/bitcraft-apps/pi-web-tools/issues/166), [#176](https://github.com/bitcraft-apps/pi-web-tools/issues/176)

## Context

The connect-time SSRF guard is a custom `lookup` hook on an undici `Agent`
(`src/lib/ssrf-agent.ts`, issue #64). It reaches a request only through the
`dispatcher:` option, so the dispatcher is not an optimization — it *is* the
guard.

`doFetch` used to pass that `Agent` to Node's **global** `fetch`, which is
backed by the undici copy Node bundles. Two undici copies met at one interface.
undici 8 reworked the dispatcher handler API, so only some pairings work. From
the measured matrix in the `src/lib/ssrf-agent.ts` header — "ok" means the
lookup hook fired and the request completed:

```
                    Node 22 (bundles 6.28)  Node 24 (7.18)   Node 26 (8.9)
  global fetch + installed 6      ok              ok        invalid onError
  global fetch + installed 7      ok              ok              ok
  global fetch + installed 8  invalid onReqStart  invalid onReqStart   ok
  same-copy undici fetch, 6       ok              ok              ok
  same-copy undici fetch, 7       ok              ok              ok
  same-copy undici fetch, 8       ok              ok              ok
```

`engines.node` spans all three columns. On the global-fetch route, undici 7 is
the only major compatible with every one — a bridge that will not last forever,
and one that cost a pinned dependency range, a Dependabot major-ignore rule
(#171), and roughly forty lines of hazard commentary to hold in place.

## Decision

Import `fetch` from the same installed undici, so the fetch and the `Agent`
always come from one copy. `src/lib/http.ts` resolves it through a module-level
`fetchImpl` binding that defaults to undici's `fetch`; `doFetch` passes
`dispatcher: getSsrfAgent()` to it.

- **The matrix is the justification, not a preference.** The bottom three rows
  are green in all nine cells: every installed major works on every supported
  Node, so no version pairing can break the connect-time hook.
- **The declared range rests on those cells.** `dependencies.undici` is
  `^6.0.0 || ^7.0.0 || ^8.0.0` because all nine were measured green (full suite
  plus the rebinding tests, re-run under each pairing, 2026-08-02). Widening to
  a future major means re-running the matrix, not assuming it.
- **`init` is typed against undici's own `RequestInit`.** That type declares
  `dispatcher`, so a future undici rename surfaces as a type error rather than a
  silent runtime no-op.
- **Tests get an explicit seam.** `__setFetchForTesting` in `src/lib/http.ts`,
  mirroring the existing `__setSsrfAgentForTesting`. Not part of the public API.

## Consequences

**Stubbing `global.fetch` no longer intercepts anything.** This is the
consequence most likely to bite. A test that writes `vi.stubGlobal("fetch", …)`
does not fail — it lets the request escape to the real network. Tests install
their fake through `test/_helpers/fetch.ts` (`stubFetch`, `restoreFetch`,
`mockFetchOnce`) instead. #176 converted 33 stub sites.

**One documented cast, in one place.** Test fakes resolve the global
`Response`, while the seam is typed as undici's `fetch`. The two differ only in
the generic on `body`'s `ReadableStream`, which no test exercises. The cast
lives in `test/_helpers/fetch.ts` rather than at every call site — same
rationale as `_helpers/context.ts` and `_helpers/theme.ts`.

**The guard has a regression test and a CI matrix.** The
`DNS-rebinding guard (issue #64)` block in `test/pipeline.test.ts` wraps
`lookupHook` in a `vi.fn()` and asserts it was called, so dropping the
dispatcher fails. The `node-matrix` job in `.github/workflows/ci.yml` runs the
suite across the nine Node × undici pairings.

**This removed a class of loud breakage, not a silent one.** Every incompatible
pairing throws at fetch time (`invalid onError method`,
`invalid onRequestStart`). The guard failed closed. #166 corrected an earlier
comment that claimed the dispatcher could stop being honored with no test
failure.

## Alternatives rejected

**1. Keep global `fetch` and pin `undici` to `^7`.** This was the state before
#176 and it worked. Rejected because the compatibility rests on one major
happening to bridge all three Node columns, and it carried a pinned range, a
Dependabot major-ignore rule (#171), and the hazard commentary as permanent
overhead.

**2. Document the hazard and leave it in place.** This *was* the outcome of
#166, which corrected the header comment and added the `node-matrix` job while
explicitly leaving `dependencies.undici` alone. #176 superseded it: documenting
a hazard is worse than deleting the hazard class when the fix is an import
change plus a test seam.

**3. Drop the `dispatcher:` and rely on `validateUrl` alone.** Rejected. That
reopens the DNS-rebinding gap #64 exists to close — string-level validation
cannot see the address the socket will connect to.

**4. Resolve the hostname first, then hand the IP to global `fetch`.** Rejected
in #64 as option 1. It leaves a rebinding window between the validating lookup
and the connecting one, and passing an IP with a `Host` header breaks SNI/TLS.
