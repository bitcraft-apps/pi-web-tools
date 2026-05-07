import { describe, it, expect } from "vitest";
import { validateUrl } from "../src/lib/url-guard.js";

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
