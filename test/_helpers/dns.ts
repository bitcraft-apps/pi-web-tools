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

export type DnsLookupImpl = (
  hostname: string,
  optionsOrFamilyOrCallback: dns.LookupOptions | number | DnsLookupCallback,
  maybeCallback?: DnsLookupCallback,
) => void;

export function mockDnsLookup(impl: DnsLookupImpl) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Centralized assertion: dns.lookup's overloaded signature can't be expressed via vitest's MockImplementation. Inner `impl` is honestly typed; this only widens the outer shape so the spy accepts it.
  return vi.spyOn(dns, "lookup").mockImplementation(impl as unknown as typeof dns.lookup);
}
