import { describe, it, expect } from "vitest";
import { paginate, stripPaginationFooter } from "../src/lib/paginate.js";

describe("paginate", () => {
  it("returns text unchanged when it fits within maxChars (offset=0)", () => {
    const out = paginate("hello world", 0, 100);
    expect(out).toBe("hello world");
  });

  it("appends a TRUNCATED footer naming the next offset when more remains", () => {
    const text = "x".repeat(1000);
    const out = paginate(text, 0, 100);
    expect(out.startsWith("x".repeat(100))).toBe(true);
    expect(out).toMatch(
      /\[TRUNCATED — returned chars \[0, 100\) of 1000 total\. Re-call with offset=100 to read the next chunk\.\]/,
    );
  });

  it("returns mid-document slice with footer citing the correct next offset", () => {
    const text = "x".repeat(1000);
    const out = paginate(text, 200, 300);
    expect(out.startsWith("x".repeat(300))).toBe(true);
    expect(out).toMatch(/returned chars \[200, 500\) of 1000 total/);
    expect(out).toMatch(/offset=500/);
  });

  it("returns clean last chunk with no footer when slice reaches text.length exactly", () => {
    const text = "x".repeat(500);
    const out = paginate(text, 400, 100);
    expect(out).toBe("x".repeat(100));
    expect(out).not.toMatch(/TRUNCATED/);
  });

  it("returns clean last chunk with no footer when maxChars overshoots end", () => {
    const text = "x".repeat(500);
    const out = paginate(text, 400, 1000);
    expect(out).toBe("x".repeat(100));
    expect(out).not.toMatch(/TRUNCATED/);
  });

  it("returns past-end marker (does not throw) when offset >= text.length", () => {
    const text = "x".repeat(500);
    const out = paginate(text, 500, 100);
    expect(out).toMatch(/OFFSET 500 PAST END/);
    expect(out).toMatch(/document is 500 chars total/);
    expect(out).toMatch(/shrank between calls/);
    // No "retry from offset=0" hint — restart-from-zero hits the same race
    // (doc shrank between calls) and wastes a fetch on an arithmetic error.
    expect(out).not.toMatch(/Re-call with offset=0/);
  });

  it("past-end marker fires for offset strictly greater than length too", () => {
    const out = paginate("hello", 999, 50);
    expect(out).toMatch(/OFFSET 999 PAST END/);
  });

  it("returns empty string for empty document at offset=0 (not the past-end marker)", () => {
    // An empty extracted body is a legitimate result (e.g. a 204-shaped
    // text response, or a page that extracts down to nothing). Returning
    // the past-end recovery marker here would mislead the model into
    // thinking it asked for the wrong offset.
    const out = paginate("", 0, 100);
    expect(out).toBe("");
  });

  it("still returns past-end marker for empty document at offset > 0", () => {
    const out = paginate("", 5, 100);
    expect(out).toMatch(/OFFSET 5 PAST END/);
    expect(out).toMatch(/document is 0 chars total/);
  });

  it("rejects maxChars < 1 (direct caller could otherwise infinite-loop past end)", () => {
    expect(() => paginate("hi", 0, 0)).toThrow(/invalid maxchars/i);
    expect(() => paginate("hi", 0, -1)).toThrow(/invalid maxchars/i);
  });

  it("rejects non-integer maxChars", () => {
    expect(() => paginate("hi", 0, 1.5)).toThrow(/invalid maxchars/i);
  });

  it("rejects negative / non-integer offset", () => {
    expect(() => paginate("hi", -1, 10)).toThrow(/invalid offset/i);
    expect(() => paginate("hi", 1.5, 10)).toThrow(/invalid offset/i);
  });

  it("snaps chunk end down by one when boundary lands inside a surrogate pair", () => {
    // "\uD83D\uDE00" = U+1F600 (😀, two UTF-16 code units). With
    // maxChars=3 the naive slice(0, 3) of "xy😀" splits the surrogate pair
    // and emits "xy" + lone high surrogate — which JSON.stringify in the
    // agent transport encodes as a \udxxx escape that strict UTF-8
    // consumers may reject. Snapping to a code-point boundary keeps the
    // chunk well-formed and mirrors the adjustment into the next-offset so
    // [offset, end) tiles cleanly.
    const text = "xy\uD83D\uDE00"; // 4 code units, 3 code points
    const chunk0 = paginate(text, 0, 3);
    expect(chunk0).toMatch(/^xy\n\n\[TRUNCATED — returned chars \[0, 2\)/);
    expect(chunk0).toMatch(/offset=2/);
    // The deferred surrogate pair lands intact in the next chunk, so
    // concatenation is lossless.
    const chunk1 = paginate(text, 2, 3);
    expect(stripPaginationFooter(chunk0) + stripPaginationFooter(chunk1)).toBe(text);
  });

  it("does not snap on the final chunk (no next call to receive the deferred half)", () => {
    // boundary at end-of-document — no footer, no snap, ship as-is.
    const text = "x\uD83D\uDE00";
    const out = paginate(text, 0, 100);
    expect(out).toBe(text);
  });
});
