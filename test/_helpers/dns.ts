// Centralized typed wrapper for stubbing `dns.lookup` in tests.
//
// Why centralize? `dns.lookup` has 8+ overloads. Vitest's
// `mockImplementation<T>` collapses an overloaded function type to its *last*
// overload, which does not match the `(hostname, options|callback,
// callback?)` shape we actually need to handle in test impls. The honest
// fix is one assertion at the boundary; the inner `impl` is fully typed and
// the call-site stays clean.

import dns from "node:dns";
import { vi } from "vitest";

type DnsLookupCallback = (
  err: NodeJS.ErrnoException | null,
  addressOrAddresses?: string | dns.LookupAddress[],
  family?: number,
) => void;

// Note: the `lookup(hostname, family, callback)` shorthand overload
// (where `family` is a bare `0 | 4 | 6`) is intentionally omitted from
// this union. No test currently exercises it, and adding `| number` to
// the second arg would force every `impl` to discriminate
// `typeof optionsOrCallback === "number"` before reading `.all` /
// `.family` off the options object — paying a real ergonomic cost in
// every call site for a code path none of them take. Add it (and the
// discriminator) only when a test actually needs it.
export type DnsLookupImpl = (
  hostname: string,
  optionsOrCallback: dns.LookupOptions | DnsLookupCallback,
  maybeCallback?: DnsLookupCallback,
) => void;

export function mockDnsLookup(impl: DnsLookupImpl) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Centralized assertion: dns.lookup's overloaded signature can't be expressed via vitest's MockImplementation. Inner `impl` is honestly typed; this only widens the outer shape so the spy accepts it.
  return vi.spyOn(dns, "lookup").mockImplementation(impl as unknown as typeof dns.lookup);
}
