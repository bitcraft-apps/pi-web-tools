import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Agent } from "undici";
import { __setSsrfAgentForTesting, lookupHook } from "../src/lib/ssrf-agent.js";
import { stubExtensionContext } from "./_helpers/context.js";
import { mockDnsLookup } from "./_helpers/dns.js";

vi.mock("../src/lib/html2md.js", () => ({
  htmlToMarkdown: vi.fn(async (html: string) => `MD:${html.slice(0, 20)}`),
}));

vi.mock("../src/lib/extract.js", () => ({
  // Default: simulate "no extractor on $PATH" — returns null, fall through to
  // full HTML. Individual tests override via mockImplementationOnce.
  extractContent: vi.fn(async () => null),
}));

import { fetchAsMarkdown } from "../src/webfetch.js";
import { htmlToMarkdown } from "../src/lib/html2md.js";
import { extractContent } from "../src/lib/extract.js";
import { MAX_RESPONSE_BYTES } from "../src/lib/headers.js";

function mockFetchOnce(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}) {
  const headers = new Headers(opts.headers ?? { "content-type": "text/html; charset=utf-8" });
  const status = opts.status ?? 200;
  const body = opts.body ?? "<h1>Hi</h1>";
  // Re-wrap any Uint8Array into a fresh `Uint8Array<ArrayBuffer>` so it lines
  // up with `BodyInit`. With recent @types/node + lib.dom, the default
  // `Uint8Array` type widens to `Uint8Array<ArrayBufferLike>` (allowing
  // SharedArrayBuffer), which `BodyInit` rejects. The copy is cheap and
  // semantically identical for these tests.
  const responseBody: BodyInit = typeof body === "string" ? body : new Uint8Array(body);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce(new Response(responseBody, { status, headers })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks doesn't drain mockResolvedValueOnce queues. Reset and
  // re-establish the default null so leftover queued values from one test
  // can't leak into the next.
  vi.mocked(extractContent).mockReset();
  vi.mocked(extractContent).mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAsMarkdown", () => {
  it("blocks non-http schemes via url-guard", async () => {
    await expect(fetchAsMarkdown({ url: "ftp://example.com" })).rejects.toThrow(/scheme/i);
  });

  it("blocks localhost", async () => {
    await expect(fetchAsMarkdown({ url: "http://localhost:3000" })).rejects.toThrow(
      /blocked host/i,
    );
  });

  it("returns markdown for HTML response", async () => {
    mockFetchOnce({ body: "<h1>Hello</h1>" });
    const md = await fetchAsMarkdown({ url: "https://example.com" });
    expect(md).toContain("MD:");
  });

  it("returns body unchanged for text/plain", async () => {
    mockFetchOnce({ body: "raw text", headers: { "content-type": "text/plain" } });
    const md = await fetchAsMarkdown({ url: "https://example.com/file.txt" });
    expect(md).toBe("raw text");
  });

  it("wraps JSON in code fence", async () => {
    mockFetchOnce({ body: '{"a":1}', headers: { "content-type": "application/json" } });
    const md = await fetchAsMarkdown({ url: "https://example.com/x.json" });
    expect(md).toMatch(/```json/);
    expect(md).toContain('"a": 1');
  });

  it("throws on PDF", async () => {
    mockFetchOnce({ body: "%PDF...", headers: { "content-type": "application/pdf" } });
    await expect(fetchAsMarkdown({ url: "https://example.com/x.pdf" })).rejects.toThrow(
      /cannot fetch.*pdf/i,
    );
  });

  it("throws on image/*", async () => {
    mockFetchOnce({ body: "...", headers: { "content-type": "image/png" } });
    await expect(fetchAsMarkdown({ url: "https://example.com/x.png" })).rejects.toThrow(
      /cannot fetch.*image/i,
    );
  });

  it("throws on HTTP 404", async () => {
    mockFetchOnce({
      status: 404,
      headers: { "content-type": "text/html" },
      body: "<h1>Not Found</h1>",
    });
    await expect(fetchAsMarkdown({ url: "https://example.com/missing" })).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it("treats unknown text mime as text/plain", async () => {
    mockFetchOnce({ body: "# md", headers: { "content-type": "text/markdown" } });
    const md = await fetchAsMarkdown({ url: "https://example.com/x.md" });
    expect(md).toBe("# md");
  });

  it("truncates output to max_chars with footer", async () => {
    const longHtml = "<p>" + "x".repeat(100) + "</p>";
    mockFetchOnce({ body: longHtml });
    const md = await fetchAsMarkdown({ url: "https://example.com", max_chars: 5 });
    expect(md.length).toBeLessThanOrEqual(5 + 200); // body + footer
    expect(md).toMatch(/TRUNCATED/);
  });

  it("rejects response > 5MB via content-length", async () => {
    mockFetchOnce({
      body: "x",
      headers: { "content-type": "text/html", "content-length": String(6 * 1024 * 1024) },
    });
    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(/too large/i);
  });

  // Issue #58: streaming-byte-cap. Content-Length is a fast-path; the real
  // enforcement reads the stream and aborts at MAX_RESPONSE_BYTES.

  // One shared oversize buffer (cap + 64 KB) for both rejection tests —
  // avoids allocating multiple 6 MB Uint8Arrays per suite run. Stream
  // factory slices windows out of it so each test gets an independent
  // ReadableStream.
  const OVERSIZE_BYTES = MAX_RESPONSE_BYTES + 64 * 1024;
  const oversize = new Uint8Array(OVERSIZE_BYTES).fill(0x78); // 'x'
  const makeOversizeStream = () =>
    new ReadableStream({
      start(controller) {
        // Push in 256 KB chunks so the cap fires mid-stream rather than on
        // the first read — exercises the per-chunk accumulator path.
        const chunkSize = 256 * 1024;
        for (let off = 0; off < OVERSIZE_BYTES; off += chunkSize) {
          controller.enqueue(oversize.subarray(off, Math.min(off + chunkSize, OVERSIZE_BYTES)));
        }
        controller.close();
      },
    });

  it("rejects response > 5MB when Content-Length is missing (chunked)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(makeOversizeStream(), {
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
        }),
      ),
    );

    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(/too large/i);
  });

  it("rejects response > 5MB when Content-Length lies (says 1 KB, sends >5 MB)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(makeOversizeStream(), {
          status: 200,
          headers: new Headers({
            "content-type": "text/html",
            // Lying — says 1 KB.
            "content-length": "1024",
          }),
        }),
      ),
    );

    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(/too large/i);
  });

  it("accepts honest 4 MB response just under the cap", async () => {
    const four = new Uint8Array(4 * 1024 * 1024).fill(0x78);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(four);
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: new Headers({ "content-type": "text/plain" }),
        }),
      ),
    );

    const out = await fetchAsMarkdown({ url: "https://example.com" });
    // text/plain path: full 4 MB body streamed through, then truncated to
    // max_chars (default 50_000) + a TRUNCATED footer. Asserting the exact
    // truncated length proves the entire body was read — a partial read
    // would either throw or produce a shorter string.
    expect(out).toMatch(/TRUNCATED/);
    expect(out.length).toBeGreaterThanOrEqual(50_000);
    expect(out.length).toBeLessThanOrEqual(50_000 + 200); // body + footer
  });
});

describe("content extraction wire-in", () => {
  it("feeds extractor output to htmlToMarkdown when extraction succeeds", async () => {
    // Body must be > 10 KB or the extractor is short-circuited.
    // Extracted must be ≥ 1% of body or the suspicion-fallback discards it.
    const article = "<article>" + "a".repeat(500) + "</article>"; // ~520 chars
    const fullHtml = "<html><nav>chrome</nav>" + article + "x".repeat(20_000) + "</html>";
    vi.mocked(extractContent).mockResolvedValueOnce(article);
    mockFetchOnce({ body: fullHtml });
    await fetchAsMarkdown({ url: "https://example.com" });
    expect(extractContent).toHaveBeenCalledWith(
      expect.stringContaining(article),
      "https://example.com",
    );
    expect(htmlToMarkdown).toHaveBeenCalledWith(article);
  });

  it("falls back to full HTML when extractor returns null", async () => {
    vi.mocked(extractContent).mockResolvedValueOnce(null);
    const fullHtml = "<html><nav>x</nav><p>body</p></html>";
    mockFetchOnce({ body: fullHtml });
    await fetchAsMarkdown({ url: "https://example.com" });
    expect(htmlToMarkdown).toHaveBeenCalledWith(fullHtml);
  });

  it("falls back to full HTML when extracted < 1% of original AND original > 10 KB", async () => {
    // Original > 10 KB, extracted way under 1%: triggers the suspicion fallback.
    const fullHtml = "<html>" + "x".repeat(20_000) + "</html>";
    vi.mocked(extractContent).mockResolvedValueOnce("<p>tiny</p>");
    mockFetchOnce({ body: fullHtml });
    await fetchAsMarkdown({ url: "https://example.com" });
    expect(htmlToMarkdown).toHaveBeenCalledWith(fullHtml);
  });

  it("falls back to full HTML when extractor returns empty string on a large page", async () => {
    // Empty-string output passes the `extracted !== null` guard; the ratio
    // guard (0 >= 1% of 20 KB) is what saves us. Regression test for the
    // "successful extractor returning literally '' triggers fallback" case.
    const fullHtml = "<html>" + "x".repeat(20_000) + "</html>";
    vi.mocked(extractContent).mockResolvedValueOnce("");
    mockFetchOnce({ body: fullHtml });
    await fetchAsMarkdown({ url: "https://example.com" });
    expect(htmlToMarkdown).toHaveBeenCalledWith(fullHtml);
  });

  it("short-circuits the extractor on small bodies (< 10 KB)", async () => {
    // Below the 10 KB threshold the ratio guard can't fire, so the spawn
    // overhead isn't worth it. extractContent must not be invoked at all;
    // htmlToMarkdown gets the raw body.
    const smallHtml = "<html>" + "x".repeat(500) + "</html>";
    mockFetchOnce({ body: smallHtml });
    await fetchAsMarkdown({ url: "https://example.com" });
    expect(extractContent).not.toHaveBeenCalled();
    expect(htmlToMarkdown).toHaveBeenCalledWith(smallHtml);
  });

  it("keeps extracted output when ratio >= 1% even on a large page", async () => {
    // Original > 10 KB, extracted is ~5% of it: ratio guard does not fire.
    const fullHtml = "<html>" + "x".repeat(20_000) + "</html>";
    const extracted = "<article>" + "y".repeat(1_500) + "</article>"; // > 1% of 20 KB
    vi.mocked(extractContent).mockResolvedValueOnce(extracted);
    mockFetchOnce({ body: fullHtml });
    await fetchAsMarkdown({ url: "https://example.com" });
    expect(htmlToMarkdown).toHaveBeenCalledWith(extracted);
  });

  it("never invokes the extractor for non-HTML responses", async () => {
    mockFetchOnce({ body: '{"a":1}', headers: { "content-type": "application/json" } });
    await fetchAsMarkdown({ url: "https://example.com/x.json" });
    expect(extractContent).not.toHaveBeenCalled();

    mockFetchOnce({ body: "plain text", headers: { "content-type": "text/plain" } });
    await fetchAsMarkdown({ url: "https://example.com/x.txt" });
    expect(extractContent).not.toHaveBeenCalled();
  });
});

describe("charset decoding", () => {
  // "Łódź" in windows-1250: Ł=0xA3, ó=0xF3, d=0x64, ź=0x9F
  const POLISH_WIN1250 = new Uint8Array([0xa3, 0xf3, 0x64, 0x9f]);
  // "Łódź" in iso-8859-2: Ł=0xA3, ó=0xF3, d=0x64, ź=0xBC
  const POLISH_ISO88592 = new Uint8Array([0xa3, 0xf3, 0x64, 0xbc]);

  it("decodes windows-1250 Polish diacritics correctly", async () => {
    mockFetchOnce({
      body: POLISH_WIN1250,
      headers: { "content-type": "text/plain; charset=windows-1250" },
    });
    const out = await fetchAsMarkdown({ url: "https://example.pl/x.txt" });
    expect(out).toBe("Łódź");
  });

  it("decodes iso-8859-2 Polish diacritics correctly", async () => {
    mockFetchOnce({
      body: POLISH_ISO88592,
      headers: { "content-type": "text/plain; charset=iso-8859-2" },
    });
    const out = await fetchAsMarkdown({ url: "https://example.pl/x.txt" });
    expect(out).toBe("Łódź");
  });

  it("is case-insensitive and tolerates whitespace/quotes around charset", async () => {
    mockFetchOnce({
      body: POLISH_WIN1250,
      headers: { "content-type": 'text/plain; charset="WINDOWS-1250"' },
    });
    const out = await fetchAsMarkdown({ url: "https://example.pl/x.txt" });
    expect(out).toBe("Łódź");
  });

  it("falls back to utf-8 on unknown charset without throwing", async () => {
    const utf8 = new TextEncoder().encode("hello świat");
    mockFetchOnce({
      body: utf8,
      headers: { "content-type": "text/plain; charset=x-bogus-encoding" },
    });
    const out = await fetchAsMarkdown({ url: "https://example.com/x.txt" });
    expect(out).toBe("hello świat");
  });

  it("defaults to utf-8 when no charset in content-type", async () => {
    const utf8 = new TextEncoder().encode("plain ąćę utf8");
    mockFetchOnce({
      body: utf8,
      headers: { "content-type": "text/plain" },
    });
    const out = await fetchAsMarkdown({ url: "https://example.com/x.txt" });
    expect(out).toBe("plain ąćę utf8");
  });
});

describe("HTML meta charset sniffing", () => {
  // "Łódź" in windows-1250
  const POLISH_WIN1250 = new Uint8Array([0xa3, 0xf3, 0x64, 0x9f]);

  function buildHtml(metaTag: string): Uint8Array {
    const head = `<!doctype html><html><head>${metaTag}</head><body>`;
    const tail = `</body></html>`;
    const headBytes = new TextEncoder().encode(head);
    const tailBytes = new TextEncoder().encode(tail);
    const out = new Uint8Array(headBytes.length + POLISH_WIN1250.length + tailBytes.length);
    out.set(headBytes, 0);
    out.set(POLISH_WIN1250, headBytes.length);
    out.set(tailBytes, headBytes.length + POLISH_WIN1250.length);
    return out;
  }

  const htmlWithMetaCharset = (charset: string) => buildHtml(`<meta charset="${charset}">`);
  const htmlWithMetaHttpEquiv = (charset: string) =>
    buildHtml(`<meta http-equiv="Content-Type" content="text/html; charset=${charset}">`);

  function lastHtmlPassedToMd(): string {
    const calls = vi.mocked(htmlToMarkdown).mock.calls;
    return calls[calls.length - 1]?.[0] ?? "";
  }

  it("honors <meta charset> when HTTP content-type omits charset", async () => {
    mockFetchOnce({
      body: htmlWithMetaCharset("windows-1250"),
      headers: { "content-type": "text/html" },
    });
    await fetchAsMarkdown({ url: "https://example.pl" });
    expect(lastHtmlPassedToMd()).toContain("Łódź");
  });

  it("honors <meta http-equiv=Content-Type> when HTTP content-type omits charset", async () => {
    mockFetchOnce({
      body: htmlWithMetaHttpEquiv("windows-1250"),
      headers: { "content-type": "text/html" },
    });
    await fetchAsMarkdown({ url: "https://example.pl" });
    expect(lastHtmlPassedToMd()).toContain("Łódź");
  });

  it("is case-insensitive in meta charset", async () => {
    mockFetchOnce({
      body: htmlWithMetaCharset("WINDOWS-1250"),
      headers: { "content-type": "text/html" },
    });
    await fetchAsMarkdown({ url: "https://example.pl" });
    expect(lastHtmlPassedToMd()).toContain("Łódź");
  });

  it("HTTP charset takes precedence over meta charset", async () => {
    // body declares utf-8 in meta but HTTP says windows-1250 → HTTP wins.
    // The meta tag itself is ASCII so decodes identically; the Polish bytes
    // (A3 F3 64 9F) only resolve to Łódź under windows-1250.
    mockFetchOnce({
      body: htmlWithMetaCharset("utf-8"),
      headers: { "content-type": "text/html; charset=windows-1250" },
    });
    await fetchAsMarkdown({ url: "https://example.pl" });
    expect(lastHtmlPassedToMd()).toContain("Łódź");
  });

  it("falls back to utf-8 when meta charset is unknown", async () => {
    const utf8 = new TextEncoder().encode(
      `<!doctype html><html><head><meta charset="x-bogus"></head><body>świat</body></html>`,
    );
    mockFetchOnce({ body: utf8, headers: { "content-type": "text/html" } });
    await fetchAsMarkdown({ url: "https://example.com" });
    expect(lastHtmlPassedToMd()).toContain("świat");
  });

  it("ignores meta charset declared past the first 1024 bytes", async () => {
    // Construct a body where the meta declaration sits past the 1024-byte sniff window
    // and the Polish bytes are windows-1250-only (0xA3, 0x9F are invalid as standalone
    // utf-8 lead bytes → yield U+FFFD on utf-8 fallback). If sniffing honored the
    // out-of-window meta we'd see "Łódź"; we want to prove we get mojibake instead.
    const padding = " ".repeat(2000);
    const head = new TextEncoder().encode(
      `<!doctype html><html><head>${padding}<meta charset="windows-1250"></head><body>`,
    );
    const tail = new TextEncoder().encode(`</body></html>`);
    const body = new Uint8Array(head.length + POLISH_WIN1250.length + tail.length);
    body.set(head, 0);
    body.set(POLISH_WIN1250, head.length);
    body.set(tail, head.length + POLISH_WIN1250.length);

    mockFetchOnce({ body, headers: { "content-type": "text/html" } });
    await fetchAsMarkdown({ url: "https://example.com" });
    const out = lastHtmlPassedToMd();
    expect(out).not.toContain("Łódź");
    expect(out).toContain("\uFFFD"); // utf-8 replacement char proves fallback fired
  });

  it("ignores meta charset inside HTML comments", async () => {
    // The only meta in the sniff window is commented out; sniffer must skip it
    // and we must fall back to utf-8.
    const utf8 = new TextEncoder().encode(
      `<!doctype html><html><head><!-- <meta charset="windows-1250"> --></head><body>świat</body></html>`,
    );
    mockFetchOnce({ body: utf8, headers: { "content-type": "text/html" } });
    await fetchAsMarkdown({ url: "https://example.com" });
    expect(lastHtmlPassedToMd()).toContain("świat");
  });

  it("ignores unterminated HTML comments in the sniff window", async () => {
    // Comment is opened but never closed before EOF of the sniff window;
    // a commented-out meta past the opener must not be honored.
    const utf8 = new TextEncoder().encode(
      `<!doctype html><html><head><!-- <meta charset="windows-1250"></head><body>świat</body></html>`,
    );
    mockFetchOnce({ body: utf8, headers: { "content-type": "text/html" } });
    await fetchAsMarkdown({ url: "https://example.com" });
    expect(lastHtmlPassedToMd()).toContain("świat");
  });

  it("does not match charset= appearing in unrelated meta attributes", async () => {
    // <meta name="description" content="...charset=windows-1250..."> must NOT trigger
    // the sniffer; body is utf-8 and should round-trip without mojibake.
    const utf8 = new TextEncoder().encode(
      `<!doctype html><html><head><meta name="description" content="talks about charset=windows-1250 encoding"></head><body>świat</body></html>`,
    );
    mockFetchOnce({ body: utf8, headers: { "content-type": "text/html" } });
    await fetchAsMarkdown({ url: "https://example.com" });
    expect(lastHtmlPassedToMd()).toContain("świat");
  });
});

describe("Cloudflare retry hack", () => {
  it("retries with UA=opencode on cf-mitigated header", async () => {
    const cfHeaders = new Headers({ "content-type": "text/html", "cf-mitigated": "challenge" });
    const okHeaders = new Headers({ "content-type": "text/html" });

    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<html>blocked</html>", { status: 200, headers: cfHeaders }),
      )
      .mockResolvedValueOnce(new Response("<h1>OK</h1>", { status: 200, headers: okHeaders }));
    vi.stubGlobal("fetch", mock);

    const md = await fetchAsMarkdown({ url: "https://example.com" });
    expect(mock).toHaveBeenCalledTimes(2);
    const secondCall = mock.mock.calls[1]![1];
    expect(secondCall.headers["User-Agent"]).toBe("opencode");
    expect(md).toContain("MD:");
  });

  it("retries with UA=opencode on 403 + 'Just a moment' body", async () => {
    const headers = new Headers({ "content-type": "text/html" });
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<html>Just a moment...</html>", { status: 403, headers }),
      )
      .mockResolvedValueOnce(new Response("<h1>OK</h1>", { status: 200, headers }));
    vi.stubGlobal("fetch", mock);

    await fetchAsMarkdown({ url: "https://example.com" });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("throws if challenge persists after retry", async () => {
    const cfHeaders = new Headers({ "content-type": "text/html", "cf-mitigated": "challenge" });
    const mock = vi
      .fn()
      .mockResolvedValue(new Response("<html>blocked</html>", { status: 200, headers: cfHeaders }));
    vi.stubGlobal("fetch", mock);

    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(
      /JS|cannot fetch/i,
    );
  });

  // Issue #59: CF detection now reads only the first 4 KB of the body.

  it("detects CF markers in first 1 KB of a 403 body", async () => {
    const html =
      "<html><head><title>Just a moment...</title></head><body>cf-chl-bypass</body></html>";
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(html, {
          status: 403,
          headers: new Headers({ "content-type": "text/html" }),
        }),
      )
      .mockResolvedValueOnce(
        new Response("<h1>OK</h1>", {
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
        }),
      );
    vi.stubGlobal("fetch", mock);

    await fetchAsMarkdown({ url: "https://example.com" });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("does NOT detect CF when markers sit past the 4 KB sniff window", async () => {
    // 5 KB of padding before the marker — acceptable miss, documented in code.
    const padding = "x".repeat(5000);
    const html = `<html><body>${padding}Just a moment...</body></html>`;
    const mock = vi.fn().mockResolvedValueOnce(
      new Response(html, {
        status: 403,
        headers: new Headers({ "content-type": "text/html" }),
      }),
    );
    vi.stubGlobal("fetch", mock);

    // Falls through to the regular 403 throw path — no retry attempted.
    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(/HTTP 403/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("does NOT detect CF on a plain 403 with no markers", async () => {
    const mock = vi.fn().mockResolvedValueOnce(
      new Response("<h1>Forbidden</h1><p>You don't have permission.</p>", {
        status: 403,
        headers: new Headers({ "content-type": "text/html" }),
      }),
    );
    vi.stubGlobal("fetch", mock);

    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(/HTTP 403/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("detects CF when the marker ends exactly at the 4 KB sniff boundary", async () => {
    // Marker fully inside the 4096-byte window with its last byte at 4095.
    const marker = "Just a moment";
    const prefix = "<html><body>";
    const padLen = 4096 - prefix.length - marker.length;
    const html = `${prefix}${"x".repeat(padLen)}${marker}...</body></html>`;
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(html, { status: 403, headers: new Headers({ "content-type": "text/html" }) }),
      )
      .mockResolvedValueOnce(
        new Response("<h1>ok</h1>", {
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
        }),
      );
    vi.stubGlobal("fetch", mock);

    await fetchAsMarkdown({ url: "https://example.com" });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("misses CF when the marker straddles the 4 KB sniff boundary (documented tradeoff)", async () => {
    // Pin the bounded-read tradeoff: a marker whose bytes cross 4096 is
    // truncated and the regex misses. If this ever needs to change, the
    // reader must over-read by at least max(marker_length) bytes.
    const marker = "Just a moment";
    const prefix = "<html><body>";
    // First byte of marker at 4090 → marker spans bytes 4090..4102, crosses 4096.
    const padLen = 4090 - prefix.length;
    const html = `${prefix}${"x".repeat(padLen)}${marker}...</body></html>`;
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(html, { status: 403, headers: new Headers({ "content-type": "text/html" }) }),
      );
    vi.stubGlobal("fetch", mock);

    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(/HTTP 403/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("does not buffer a multi-MB 403 body just to sniff", async () => {
    // Streamed 6 MB 403 body in 256 KB chunks; if isCloudflareChallenge
    // naively clone().text()'d it, the consumer would pull every chunk.
    // With the bounded reader we cancel after 4 KB — i.e. after the *first*
    // 256 KB chunk — so most enqueues should never be pulled.
    const totalBytes = 6 * 1024 * 1024;
    const chunkSize = 256 * 1024;
    const totalChunks = totalBytes / chunkSize;
    let enqueued = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (enqueued >= totalChunks) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunkSize).fill(0x78));
        enqueued++;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(stream, {
          status: 403,
          headers: new Headers({ "content-type": "text/html" }),
        }),
      ),
    );

    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(/HTTP 403/);
    // Sniff window is 4 KB; one 256 KB chunk satisfies it. Anything close to
    // `totalChunks` would mean we drained the whole body.
    expect(enqueued).toBeLessThan(totalChunks);
    expect(enqueued).toBeLessThanOrEqual(2);
  });
});

import { webfetchTool } from "../src/webfetch.js";

function redirectResponse(location: string, status = 302): Response {
  return new Response("", { status, headers: new Headers({ location }) });
}

describe("redirect re-validation (issue #57)", () => {
  // Per-test fetch stubs are restored by the top-level `vi.unstubAllGlobals()`
  // afterEach; no per-describe save/restore needed.

  it("follows a redirect that stays on a public host", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("https://example.org/landing"))
      .mockResolvedValueOnce(
        new Response("<h1>OK</h1>", {
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
        }),
      );
    vi.stubGlobal("fetch", mock);

    const md = await fetchAsMarkdown({ url: "https://example.com" });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(md).toContain("MD:");
  });

  it("throws when 302 points at loopback", async () => {
    const mock = vi.fn().mockResolvedValueOnce(redirectResponse("http://127.0.0.1/admin"));
    vi.stubGlobal("fetch", mock);

    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(/blocked host/i);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("throws when 302 points at AWS IMDS (link-local)", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("http://169.254.169.254/latest/meta-data/"));
    vi.stubGlobal("fetch", mock);

    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(/blocked host/i);
  });

  // Pending until #56 lands (expanded RFC1918 blocklist). Once both PRs are
  // merged, the existing localhost/loopback/link-local cases plus the new
  // RFC1918 ranges all flow through the same revalidation path proven below.
  it.todo("throws when 302 points at RFC1918 (depends on #56 expanded guard)");

  it("throws when 302 points at localhost by name", async () => {
    const mock = vi.fn().mockResolvedValueOnce(redirectResponse("http://localhost:3000/admin"));
    vi.stubGlobal("fetch", mock);

    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(/blocked host/i);
  });

  it("resolves relative Location against current URL", async () => {
    // Relative redirect target that itself is a blocked alt-encoding would
    // be impossible (always relative to https://example.com); this just
    // proves relative paths flow through validateUrl correctly.
    const mock = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse("/landing"))
      .mockResolvedValueOnce(
        new Response("<h1>OK</h1>", {
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
        }),
      );
    vi.stubGlobal("fetch", mock);

    await fetchAsMarkdown({ url: "https://example.com/page" });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[1]![0].toString()).toBe("https://example.com/landing");
  });

  it("caps redirect chain at MAX_REDIRECTS", async () => {
    let i = 0;
    const mock = vi.fn().mockImplementation(async () => {
      // Deterministic counter — each hop redirects to a fresh public URL.
      // example0..example5.com aren't IANA-reserved, but validateUrl currently
      // does no DNS resolution — it's a syntactic + scheme/host-shape guard.
      // If a future guard resolves+checks IPs (see DNS-rebinding follow-up),
      // swap these for sub-labels of example.com (which IS reserved).
      return redirectResponse(`https://example${i++}.com/`);
    });
    vi.stubGlobal("fetch", mock);

    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(
      /too many redirects/i,
    );
  });

  it("returns a 3xx with no Location instead of looping", async () => {
    // Synthesize a 3xx that allows a body. Null-body statuses per the Fetch
    // spec are 101/103/204/205/304, so 300 Multiple Choices works and avoids
    // 305 Use Proxy (deprecated, increasingly filtered by clients/parsers).
    const mock = vi.fn().mockResolvedValueOnce(
      new Response("<h1>weird 3xx</h1>", {
        status: 300,
        headers: new Headers({ "content-type": "text/html" }),
      }),
    );
    vi.stubGlobal("fetch", mock);

    await fetchAsMarkdown({ url: "https://example.com" });
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

// Drill through the TypeError("fetch failed") wrapper undici puts around
// connect-time errors. Walks both `.cause` (the common case) and `.errors[]`
// (AggregateError, which undici uses when Happy Eyeballs / `all: true` tries
// multiple addresses and they all fail). Without the AggregateError fallback,
// a multi-address path could hide the EBLOCKED inside `.errors[]` and the
// test would silently fall back to `String(err)`, masking a real bypass.
function walkBlocked(err: unknown): NodeJS.ErrnoException | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    if (cur instanceof Error && (cur as NodeJS.ErrnoException).code === "EBLOCKED") {
      return cur as NodeJS.ErrnoException;
    }
    if (cur && typeof cur === "object") {
      const c = (cur as { cause?: unknown }).cause;
      if (c) stack.push(c);
      const errs = (cur as { errors?: unknown }).errors;
      if (Array.isArray(errs)) stack.push(...errs);
    }
  }
  return null;
}

function blockedCause(err: unknown): string {
  const blocked = walkBlocked(err);
  return blocked ? blocked.message : String(err);
}

describe("DNS-rebinding guard (issue #64)", () => {
  // These tests do NOT mock global.fetch — we need the real undici fetch to
  // run so it goes through ssrfAgent's lookup hook. dns.lookup is stubbed so
  // no actual network traffic happens (the lookup fails with EBLOCKED before
  // any TCP connect is attempted).
  //
  // We install a fresh Agent built around a `vi.fn()`-wrapped `lookupHook`
  // (`hookSpy`) before each test and assert it was actually invoked. This is
  // the only thing that proves Node's bundled fetch honored our `dispatcher:`
  // option — if a future undici dual-copy drift caused the dispatcher to be
  // silently dropped, dns.lookup would still get called by undici's default
  // connector, the request would still fail (because we stub dns to a blocked
  // address), but `hookSpy` would have zero calls. See ssrf-agent.ts header.
  // Saved before any test mocks `global.fetch` so the rebind-redirect test
  // below can forward hop 2 to the real undici fetch (so ssrfAgent's lookup
  // hook actually runs and we exercise the connect-time recheck).
  //
  // We do NOT need this for restoration: the top-level `vi.unstubAllGlobals()`
  // afterEach already restores `global.fetch` between tests, and
  // `vi.stubGlobal` snapshots the pre-stub value internally. This binding
  // exists solely to forward hop 2.
  const originalFetch = global.fetch;
  let hookSpy: ReturnType<typeof vi.fn<typeof lookupHook>>;
  beforeEach(() => {
    hookSpy = vi.fn<typeof lookupHook>(lookupHook);
    __setSsrfAgentForTesting(new Agent({ connect: { lookup: hookSpy } }));
  });
  afterEach(() => {
    __setSsrfAgentForTesting(null);
    vi.restoreAllMocks();
  });

  function stubDns(address: string, family: 4 | 6) {
    return mockDnsLookup((_hostname, optionsOrCallback, maybeCallback) => {
      const cb = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback!;
      const opts = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
      if (opts.all) {
        cb(null, [{ address, family }]);
      } else {
        cb(null, address, family);
      }
    });
  }

  it("blocks a public name whose A record points at loopback", async () => {
    // Public-looking hostname that passes validateUrl, then resolves to
    // 127.0.0.1 — classic DNS rebinding. Without the connect-time recheck,
    // this would hit whatever was on localhost.
    stubDns("127.0.0.1", 4);
    const err = await fetchAsMarkdown({ url: "http://rebind.example" }).then(
      () => null,
      (e) => e,
    );
    expect(err).not.toBeNull();
    expect(hookSpy).toHaveBeenCalled();
    const blocked = walkBlocked(err);
    expect(blocked?.code).toBe("EBLOCKED");
    expect(blocked?.message).toMatch(/127\.0\.0\.1/);
  });

  it("blocks a public name whose A record points at AWS IMDS", async () => {
    stubDns("169.254.169.254", 4);
    const err = await fetchAsMarkdown({ url: "http://metadata.example" }).then(
      () => null,
      (e) => e,
    );
    expect(blockedCause(err)).toMatch(/169\.254\.169\.254/);
  });

  it("blocks a public name whose AAAA record points at IPv6 loopback", async () => {
    stubDns("::1", 6);
    const err = await fetchAsMarkdown({ url: "http://rebind6.example" }).then(
      () => null,
      (e) => e,
    );
    expect(blockedCause(err)).toMatch(/Blocked host.*::1/);
  });

  it("blocks a redirect target whose hostname rebinds to private", async () => {
    // Two-stage attack: hop 1 is mocked at the global.fetch level (so we
    // don't depend on a real public server existing); hop 2 is a public
    // name that DNS-resolves to RFC1918. The redirect URL passes
    // validateUrl (string looks public), but the connect-time lookup must
    // reject it.
    stubDns("10.0.0.1", 4);
    let calls = 0;
    vi.stubGlobal("fetch", ((
      url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      calls++;
      if (calls === 1) {
        return Promise.resolve(
          new Response("", {
            status: 302,
            headers: new Headers({ location: "http://rebound.example/x" }),
          }),
        );
      }
      // Hand off to real undici fetch for hop 2 so ssrfAgent.lookup runs.
      return originalFetch(url, init);
    }) satisfies typeof fetch);

    const err = await fetchAsMarkdown({ url: "https://example.com" }).then(
      () => null,
      (e) => e,
    );
    // Assert specifically on err.cause-chain code === "EBLOCKED" (not just a
    // message substring). If the dispatcher were silently dropped, hop 2's
    // real DNS lookup of `rebound.example` would NXDOMAIN and the test could
    // pass-by-accident on a regex match against the wrong error. The code
    // check ensures the failure originated from our lookup hook.
    expect(hookSpy).toHaveBeenCalled();
    const blocked = walkBlocked(err);
    expect(blocked?.code).toBe("EBLOCKED");
    expect(blocked?.message).toMatch(/10\.0\.0\.1/);
    expect(calls).toBe(2);
  });
});

describe("webfetchTool", () => {
  it("has correct shape", () => {
    expect(webfetchTool.name).toBe("webfetch");
    expect(webfetchTool.description).toMatch(/markdown/i);
    expect(typeof webfetchTool.execute).toBe("function");
  });

  it("returns text content from fetchAsMarkdown", async () => {
    mockFetchOnce({ body: "<h1>Hi</h1>" });
    const result = await webfetchTool.execute(
      "tc",
      { url: "https://example.com" },
      new AbortController().signal,
      () => {},
      stubExtensionContext(),
    );
    expect(result.content[0]!.type).toBe("text");
    const textContent = result.content[0]!;
    if (textContent.type === "text") {
      expect(textContent.text).toContain("MD:");
    }
  });
});
