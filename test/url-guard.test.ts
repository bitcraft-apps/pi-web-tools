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
});
