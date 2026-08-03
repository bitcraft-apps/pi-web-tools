import { describe, it, expect } from "vitest";
import { parseRetryAfter } from "../src/lib/http.js";

describe("parseRetryAfter (issue #121)", () => {
  it("parses integer seconds", () => {
    expect(parseRetryAfter("5")).toBe(5_000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("returns null for missing header", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("   ")).toBeNull();
  });

  it("returns null for malformed values", () => {
    expect(parseRetryAfter("not-a-number")).toBeNull();
    expect(parseRetryAfter("1.5")).toBeNull(); // RFC requires integer seconds
    expect(parseRetryAfter("-3")).toBeNull();
  });

  it("parses HTTP-date in the future", () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).not.toBeNull();
    // HTTP-date precision is one second, plus a tiny clock delta between
    // generating `future` and parsing it. 5500ms upper bound: 1s rounding +
    // ~500ms of CI slop, no more.
    expect(ms!).toBeGreaterThanOrEqual(0);
    expect(ms!).toBeLessThanOrEqual(5_500);
  });

  it("clamps past HTTP-date to 0", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });

  it("accepts very large integers (caller is responsible for capping)", () => {
    // 1 hour. parseRetryAfter does not cap — fetchAsMarkdown does, against
    // RETRY_AFTER_MAX_MS. This separation is what lets the function stay pure.
    expect(parseRetryAfter("3600")).toBe(3_600_000);
  });
});
