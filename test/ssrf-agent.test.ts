import { describe, it, expect, vi, afterEach } from "vitest";
import { ssrfLookup } from "../src/lib/ssrf-agent.js";
import { mockDnsLookup } from "./_helpers/dns.js";

// Stub dns.lookup so we can deterministically inject "rebinding" answers
// without actually hitting a resolver.
function stubLookup(answer: { address: string; family: 4 | 6 } | Error) {
  return mockDnsLookup((_hostname, optionsOrCallback, maybeCallback) => {
    const cb = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback!;
    const opts = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    if (answer instanceof Error) {
      cb(answer, "", 0);
      return;
    }
    if (opts.all) {
      cb(null, [{ address: answer.address, family: answer.family }]);
    } else {
      cb(null, answer.address, answer.family);
    }
  });
}

describe("ssrfLookup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects when dns answer is loopback v4", async () => {
    stubLookup({ address: "127.0.0.1", family: 4 });
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      ssrfLookup("evil.example", {}, (e) => resolve(e));
    });
    expect(err).not.toBeNull();
    expect(err!.code).toBe("EBLOCKED");
    expect(err!.message).toMatch(/127\.0\.0\.1/);
  });

  it("rejects when dns answer is AWS IMDS link-local", async () => {
    stubLookup({ address: "169.254.169.254", family: 4 });
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      ssrfLookup("rebound.example", {}, (e) => resolve(e));
    });
    expect(err?.code).toBe("EBLOCKED");
  });

  it("rejects when dns answer is RFC1918", async () => {
    stubLookup({ address: "10.0.0.1", family: 4 });
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      ssrfLookup("intranet.example", {}, (e) => resolve(e));
    });
    expect(err?.code).toBe("EBLOCKED");
  });

  it("rejects when dns answer is IPv6 loopback", async () => {
    stubLookup({ address: "::1", family: 6 });
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      ssrfLookup("evil.example", {}, (e) => resolve(e));
    });
    expect(err?.code).toBe("EBLOCKED");
  });

  it("passes through public v4 answer", async () => {
    stubLookup({ address: "1.1.1.1", family: 4 });
    const result = await new Promise<{ a?: string; f?: number; e: unknown }>((resolve) => {
      ssrfLookup("public.example", {}, (e, a, f) => {
        // a is `string | LookupAddress[]` per the dns typings; ssrfLookup
        // forwards the underlying v4 single-address answer unchanged. We
        // narrow with a runtime check rather than asserting on a type the
        // callee may legitimately widen in the future.
        const addr = typeof a === "string" ? a : undefined;
        resolve({ e, a: addr, f });
      });
    });
    expect(result.e).toBeNull();
    expect(result.a).toBe("1.1.1.1");
    expect(result.f).toBe(4);
  });

  it("rejects ANY blocked address in an `all: true` answer", async () => {
    // Real-world DNS-rebinder trick: return one public + one private to defeat
    // a "first answer wins" guard. net.connect may try the list in order and
    // fall back to the private one on connect failure.
    mockDnsLookup((_h, optionsOrCallback, maybeCallback) => {
      const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback!;
      callback(null, [
        { address: "1.1.1.1", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]);
    });

    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      ssrfLookup("mixed.example", { all: true }, (e) => resolve(e));
    });
    expect(err?.code).toBe("EBLOCKED");
    expect(err!.message).toMatch(/127\.0\.0\.1/);
  });

  it("propagates dns errors unchanged", async () => {
    const dnsErr = Object.assign(new Error("nxdomain") as NodeJS.ErrnoException, {
      code: "ENOTFOUND",
    });
    stubLookup(dnsErr);
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      ssrfLookup("missing.example", {}, (e) => resolve(e));
    });
    expect(err?.code).toBe("ENOTFOUND");
  });
});
