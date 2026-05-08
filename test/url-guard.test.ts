import { describe, it, expect } from "vitest";
import { validateUrl, isBlockedAddress } from "../src/lib/url-guard.js";

describe("validateUrl", () => {
  it("accepts valid https URL", () => {
    expect(() => validateUrl("https://example.com/page")).not.toThrow();
  });

  it("accepts valid http URL", () => {
    expect(() => validateUrl("http://example.com")).not.toThrow();
  });

  it("rejects invalid URL", () => {
    expect(() => validateUrl("not a url")).toThrow(/invalid url/i);
  });

  it("rejects non-http scheme", () => {
    expect(() => validateUrl("ftp://example.com")).toThrow(/scheme/i);
    expect(() => validateUrl("file:///etc/passwd")).toThrow(/scheme/i);
    expect(() => validateUrl("javascript:alert(1)")).toThrow(/scheme/i);
  });

  it("rejects localhost", () => {
    expect(() => validateUrl("http://localhost:3000")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://LOCALHOST")).toThrow(/blocked host/i);
  });

  it("rejects loopback IPs", () => {
    expect(() => validateUrl("http://127.0.0.1")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://127.1.2.3")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://[::1]")).toThrow(/blocked host/i);
  });

  it("rejects 0.0.0.0", () => {
    expect(() => validateUrl("http://0.0.0.0")).toThrow(/blocked host/i);
  });

  it("rejects link-local 169.254.x.x", () => {
    expect(() => validateUrl("http://169.254.169.254/latest/meta-data")).toThrow(/blocked host/i);
  });

  it("rejects empty host", () => {
    expect(() => validateUrl("http:///path")).toThrow();
  });

  // Issue #56: expanded SSRF coverage.

  it("rejects RFC1918 10.0.0.0/8", () => {
    expect(() => validateUrl("http://10.0.0.1")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://10.255.255.255")).toThrow(/blocked host/i);
  });

  it("rejects RFC1918 172.16.0.0/12", () => {
    expect(() => validateUrl("http://172.16.0.1")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://172.31.255.255")).toThrow(/blocked host/i);
    // 172.32.x.x is OUTSIDE the /12.
    expect(() => validateUrl("http://172.32.0.1")).not.toThrow();
    expect(() => validateUrl("http://172.15.0.1")).not.toThrow();
  });

  it("rejects RFC1918 192.168.0.0/16", () => {
    expect(() => validateUrl("http://192.168.0.1")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://192.168.255.255")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://192.169.0.1")).not.toThrow();
  });

  it("rejects CGNAT 100.64.0.0/10", () => {
    expect(() => validateUrl("http://100.64.0.1")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://100.127.255.255")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://100.63.255.255")).not.toThrow();
    expect(() => validateUrl("http://100.128.0.1")).not.toThrow();
  });

  it("rejects 0.0.0.0/8 including bare 0", () => {
    expect(() => validateUrl("http://0.1.2.3")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://0")).toThrow(/blocked host/i);
  });

  it("rejects limited broadcast 255.255.255.255", () => {
    expect(() => validateUrl("http://255.255.255.255")).toThrow(/blocked host/i);
  });

  it("rejects multicast 224.0.0.0/4", () => {
    expect(() => validateUrl("http://224.0.0.1")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://239.255.255.255")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://223.255.255.255")).not.toThrow();
    expect(() => validateUrl("http://240.0.0.1")).not.toThrow();
  });

  it("rejects /etc/hosts loopback aliases", () => {
    expect(() => validateUrl("http://ip6-localhost")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://ip6-loopback")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://localhost.localdomain")).toThrow(/blocked host/i);
  });

  it("rejects loopback via decimal IP encoding", () => {
    // 127.0.0.1 = 2130706433
    expect(() => validateUrl("http://2130706433")).toThrow(/blocked host/i);
  });

  it("rejects loopback via octal IP encoding", () => {
    expect(() => validateUrl("http://0177.0.0.1")).toThrow(/blocked host/i);
  });

  it("rejects loopback via hex IP encoding", () => {
    expect(() => validateUrl("http://0x7f.0.0.1")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://0x7f000001")).toThrow(/blocked host/i);
  });

  it("locks parseIPv4 boundary at 2^32", () => {
    // 0xffffffff = 255.255.255.255 (limited broadcast — blocked).
    expect(() => validateUrl("http://0xffffffff")).toThrow(/blocked host/i);
    // 0x100000000 = 2^32, just past the 32-bit max. Node's URL parser itself
    // rejects this as an invalid IPv4 host; if it ever stops doing so,
    // parseIPv4's `nums[last] >= max` check catches it (→ DNS-name branch).
    expect(() => validateUrl("http://0x100000000")).toThrow(/invalid url|blocked host/i);
  });

  it("rejects loopback via 2-part shorthand", () => {
    // 127.1 = 127.0.0.1 per WHATWG ipv4 parser
    expect(() => validateUrl("http://127.1")).toThrow(/blocked host/i);
  });

  it("rejects IPv6 ULA fc00::/7", () => {
    expect(() => validateUrl("http://[fc00::1]")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://[fdff:ffff::1]")).toThrow(/blocked host/i);
  });

  it("rejects IPv6 link-local fe80::/10", () => {
    expect(() => validateUrl("http://[fe80::1]")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://[febf::1]")).toThrow(/blocked host/i);
  });

  it("rejects IPv4-mapped IPv6 of blocked v4", () => {
    expect(() => validateUrl("http://[::ffff:127.0.0.1]")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://[::ffff:10.0.0.1]")).toThrow(/blocked host/i);
    expect(() => validateUrl("http://[::ffff:169.254.169.254]")).toThrow(/blocked host/i);
  });

  it("rejects 6to4 (2002::/16) wrapping a blocked v4", () => {
    // 2002:7f00:0001:: → embedded v4 = 127.0.0.1
    expect(() => validateUrl("http://[2002:7f00:0001::]")).toThrow(/blocked host/i);
    // 2002:a9fe:a9fe:: → embedded v4 = 169.254.169.254 (AWS IMDS)
    expect(() => validateUrl("http://[2002:a9fe:a9fe::]")).toThrow(/blocked host/i);
    // 2002:0808:0808:: → embedded v4 = 8.8.8.8 (public) — must pass
    expect(() => validateUrl("http://[2002:0808:0808::]")).not.toThrow();
  });

  it("rejects Teredo (2001:0::/32) wrapping a blocked client v4", () => {
    // Teredo client v4 is XOR'd with 0xff. 127.0.0.1 → 80ff:fffe.
    expect(() => validateUrl("http://[2001:0:0:0:0:0:80ff:fffe]")).toThrow(/blocked host/i);
    // Public client v4 8.8.8.8 → f7f7:f7f7 — must pass.
    expect(() => validateUrl("http://[2001:0:0:0:0:0:f7f7:f7f7]")).not.toThrow();
  });

  it("accepts public IPv6", () => {
    expect(() => validateUrl("http://[2606:4700:4700::1111]")).not.toThrow();
  });

  it("accepts public IPv4", () => {
    expect(() => validateUrl("http://1.1.1.1")).not.toThrow();
    expect(() => validateUrl("http://8.8.8.8")).not.toThrow();
  });

  it("treats unparseable hosts as DNS names (passes guard)", () => {
    // We cannot resolve at validation time; DNS rebinding is out of scope.
    expect(() => validateUrl("http://example.internal")).not.toThrow();
  });
});

// Issue #64: connect-time IP recheck for DNS rebinding. validateUrl is
// string-only; isBlockedAddress is the helper the connect hook uses to
// re-validate the resolved IP before the socket opens.
describe("isBlockedAddress", () => {
  it("blocks loopback v4", () => {
    expect(isBlockedAddress("127.0.0.1", 4)).toBe(true);
    expect(isBlockedAddress("127.42.0.7", 4)).toBe(true);
  });

  it("blocks RFC1918 v4", () => {
    expect(isBlockedAddress("10.0.0.1", 4)).toBe(true);
    expect(isBlockedAddress("172.16.0.1", 4)).toBe(true);
    expect(isBlockedAddress("192.168.1.1", 4)).toBe(true);
  });

  it("blocks AWS IMDS link-local", () => {
    expect(isBlockedAddress("169.254.169.254", 4)).toBe(true);
  });

  it("blocks IPv6 loopback and ULA", () => {
    expect(isBlockedAddress("::1", 6)).toBe(true);
    expect(isBlockedAddress("fc00::1", 6)).toBe(true);
    expect(isBlockedAddress("fe80::1", 6)).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 of a blocked v4", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1", 6)).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254", 6)).toBe(true);
  });

  it("infers family from address shape when omitted", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::1")).toBe(true);
  });

  it("passes public addresses", () => {
    expect(isBlockedAddress("1.1.1.1", 4)).toBe(false);
    expect(isBlockedAddress("8.8.8.8", 4)).toBe(false);
    expect(isBlockedAddress("2606:4700:4700::1111", 6)).toBe(false);
  });

  it("returns false for unparseable inputs (caller handles)", () => {
    // dns.lookup never returns garbage like this in practice; documented
    // tradeoff is to fall through rather than throw.
    expect(isBlockedAddress("not-an-ip")).toBe(false);
  });
});
