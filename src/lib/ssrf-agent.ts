// Connect-time SSRF guard. Closes the DNS-rebinding gap left open by
// `validateUrl` (which only inspects the URL string): a public hostname like
// `evil.example` whose A record points at 127.0.0.1 / 10.0.0.0/8 / AWS IMDS
// (169.254.169.254) passes string-level validation but reaches an internal
// service once Node's fetch resolves the name and connects.
//
// Fix shape (Option 2 in issue #64): pin DNS resolution to a single answer
// and re-run the same range checks against that resolved IP *before* the
// socket is opened. We do this by giving undici's connector a custom
// `lookup` (the same hook `net.connect` uses): we call `dns.lookup`, run the
// answer through `isBlockedAddress`, and either pass the address through to
// the connector or fail the lookup with an EBLOCKED error.
//
// Why this races less than "resolve, then fetch": the IP we validate is the
// same IP the socket connects to, because `lookup` returns it directly. A
// rebinder cannot return a public IP to a separate validation lookup and
// then a private IP to the connect lookup \u2014 there is only one lookup, and
// SNI/TLS still uses the original hostname (no Host-header surgery).
//
// IP-literal hostnames (e.g. `http://127.0.0.1`) bypass DNS entirely in
// `net.connect`, so the lookup hook is not invoked for them. That's fine:
// `validateUrl` already rejects literals in the blocked ranges before we
// ever call fetch.
//
// KNOWN CONSTRAINT — undici dual-copy drift
// ------------------------------------------
// Node ships its own bundled copy of undici behind global `fetch`. The
// `dispatcher:` per-request option is recognized by Node's bundled fetch via
// a duck-typed/symbol interface, and our user-installed undici's `Agent`
// happens to satisfy it. If the installed undici (`dependencies` in
// package.json) drifts a major version away from the one Node bundles, the
// dispatcher hook can silently stop being honored — fetch would then bypass
// `lookupHook` and re-open the SSRF/DNS-rebinding hole, with no test failure
// (unit tests stub `dns.lookup`, so they pass even if undici is bypassed).
//
// We support `engines.node >= 22`. Node 22 LTS bundles undici 6.x and Node
// 24 bundles undici 7.x; we cannot pin a single major that matches both, so
// `dependencies.undici` is set to `^6.0.0 || ^7.0.0` — npm will resolve to
// the major closest to the host Node, minimizing the symbol-identity risk.
// Mitigations:
//   - Range-pin spans both supported Node majors (above) so `npm install`
//     picks a compatible undici without manual intervention.
//   - The end-to-end test in test/webfetch.test.ts wraps `lookupHook` in a
//     `vi.fn()` and asserts `toHaveBeenCalled()` on every rebinding case.
//     If a future undici/Node combo silently drops the `dispatcher:` option,
//     that assertion fails (default connector wouldn't go through our hook),
//     surfacing the bypass instead of letting it ship.
//   - Track upstream undici / Node interop changes; revisit if Node exposes
//     a stable public API for connect-time DNS hooks.

import dns from "node:dns";
import net from "node:net";
import { Agent } from "undici";
import { isBlockedAddress } from "./url-guard.js";

// Use net.LookupFunction's own callback type so undici/net's call site and
// our internal `cb` agree without unsafe casts. The callback is overloaded
// to accept either a single (address, family) or a LookupAddress[] payload.
type LookupCallback = Parameters<net.LookupFunction>[2];

function blockedError(hostname: string, address: string): NodeJS.ErrnoException {
  const err = new Error(
    `Blocked host (SSRF guard): ${hostname} resolved to ${address}`,
  ) as NodeJS.ErrnoException;
  err.code = "EBLOCKED";
  return err;
}

// Exported for unit testing. Real usage is via `ssrfAgent` below.
export function ssrfLookup(
  hostname: string,
  options: dns.LookupOptions | LookupCallback,
  callback?: LookupCallback,
): void {
  // dns.lookup signature is (hostname, [options], callback). Normalize.
  const opts: dns.LookupOptions = typeof options === "function" ? {} : (options ?? {});
  const cb: LookupCallback | undefined = typeof options === "function" ? options : callback;
  if (!cb) throw new TypeError("ssrfLookup requires a callback");

  dns.lookup(hostname, opts, (err, address, family) => {
    if (err) {
      cb(err, "", 0);
      return;
    }
    // `all: true` form returns an array; reject if ANY address is blocked,
    // since net.connect may pick any of them (and undici/node may iterate
    // through the list on connect failure).
    if (Array.isArray(address)) {
      for (const a of address) {
        if (isBlockedAddress(a.address, a.family)) {
          cb(blockedError(hostname, a.address), "", 0);
          return;
        }
      }
      // Pass the array through unchanged: every element was just validated
      // by isBlockedAddress above, so handing the full list back to undici
      // (which may iterate via Happy Eyeballs across families on connect
      // failure) is safe.
      (cb as (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void)(
        null,
        address,
      );
      return;
    }
    if (typeof address !== "string") {
      // dns.lookup contract: when `all` is false the address is always a
      // string. Anything else means a resolver bug or a malicious shim —
      // fail closed rather than coerce an unknown value through to net.connect.
      cb(blockedError(hostname, String(address)), "", 0);
      return;
    }
    if (isBlockedAddress(address, family)) {
      cb(blockedError(hostname, address), "", 0);
      return;
    }
    // dns.lookup on success always returns family 4 or 6. Anything else is a
    // contract violation by the resolver — fail closed rather than pass a
    // bogus family through to net.connect.
    if (family !== 4 && family !== 6) {
      cb(blockedError(hostname, address), "", 0);
      return;
    }
    cb(null, address, family);
  });
}

// Match net.LookupFunction shape so undici/net call us with a single concrete
// signature; we then forward into ssrfLookup which uses the same type.
// Exported so tests can wrap it in a `vi.fn()` and assert the dispatcher
// actually routed traffic through us (proves Node's bundled fetch did not
// silently drop the `dispatcher:` option — see dual-copy note above).
export const lookupHook: net.LookupFunction = (hostname, options, callback) => {
  ssrfLookup(hostname, options, callback);
};

// Lazy singleton: the Agent (and its connection pool) is constructed on
// first use rather than at module load. This keeps `import "./webfetch.js"`
// from a non-fetching context (typecheck-only consumers, doc generators)
// free of side effects. Once created, the dispatcher is reused across calls
// so connection pooling still works.
//
// We deliberately never call `cachedAgent.close()`. The pool lives for the
// lifetime of the process; for a CLI tool / short-lived agent loop that's
// the correct trade-off (closing on every fetch would defeat keep-alive).
// If this module is ever reused in a long-lived daemon with bounded host
// sets, revisit and add an explicit shutdown hook.
let cachedAgent: Agent | null = null;
export function getSsrfAgent(): Agent {
  cachedAgent ??= new Agent({
    connect: {
      lookup: lookupHook,
    },
  });
  return cachedAgent;
}

// Test-only seam. Lets a test install an Agent built around a `vi.fn()`-
// wrapped lookup hook so it can assert the dispatcher path was honored.
// Not part of the public API; do not call from production code.
export function __setSsrfAgentForTesting(agent: Agent | null): void {
  cachedAgent = agent;
}
