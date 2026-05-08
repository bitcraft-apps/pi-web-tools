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
      // The 4-arg overload of LookupCallback is what `all: true` consumers
      // expect. Cast through unknown because the union of overloads can't be
      // expressed as a single positional call site.
      (cb as (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void)(
        null,
        address,
      );
      return;
    }
    if (typeof address === "string" && isBlockedAddress(address, family)) {
      cb(blockedError(hostname, address), "", 0);
      return;
    }
    cb(null, address as string, family ?? 0);
  });
}

// Match net.LookupFunction shape so undici/net call us with a single concrete
// signature; we then forward into ssrfLookup which uses the same type.
const lookupHook: net.LookupFunction = (hostname, options, callback) => {
  ssrfLookup(hostname, options, callback);
};

// Singleton dispatcher passed per-request to fetch(). Kept module-scoped so
// connection pooling works across calls; the lookup hook itself is stateless.
export const ssrfAgent = new Agent({
  connect: {
    lookup: lookupHook,
  },
});
