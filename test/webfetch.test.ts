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

vi.mock("../src/lib/pdf.js", () => ({
  // Default: simulate "no pdftotext on $PATH" — returns null. fetchAsMarkdown
  // then throws the historical "Cannot fetch application/pdf" error, which
  // pins the no-poppler regression-free contract from issue #119.
  pdfToText: vi.fn(async () => null),
}));

import {
  fetchAsMarkdown,
  looksLikeJsShell,
  paginate,
  parseRetryAfter,
  RETRY_AFTER_MAX_MS,
} from "../src/webfetch.js";
import { htmlToMarkdown } from "../src/lib/html2md.js";
import { extractContent } from "../src/lib/extract.js";
import { pdfToText } from "../src/lib/pdf.js";
import { ACCEPT_HEADER, MAX_RESPONSE_BYTES } from "../src/lib/headers.js";

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
  vi.mocked(pdfToText).mockReset();
  vi.mocked(pdfToText).mockResolvedValue(null);
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

  it("throws on PDF when pdftotext is unavailable (preserves pre-#119 error)", async () => {
    // Default mock returns null (no pdftotext). The verbatim error string
    // is the regression-free contract: users who haven't installed poppler
    // see exactly the same message they always saw.
    mockFetchOnce({ body: "%PDF...", headers: { "content-type": "application/pdf" } });
    await expect(fetchAsMarkdown({ url: "https://example.com/x.pdf" })).rejects.toThrow(
      /cannot fetch.*pdf/i,
    );
  });

  it("routes PDF through pdftotext when available and returns plain text", async () => {
    vi.mocked(pdfToText).mockResolvedValueOnce("Hello from a PDF.");
    mockFetchOnce({ body: "%PDF-1.7 ...", headers: { "content-type": "application/pdf" } });
    const out = await fetchAsMarkdown({ url: "https://example.com/x.pdf" });
    expect(out).toBe("Hello from a PDF.");
    // Plain text — no markdown wrapping, no fences. Per issue #119 explicit
    // non-goal: "Output is plain text — no markdown wrapping, no fences."
    expect(out).not.toMatch(/^```/);
    expect(pdfToText).toHaveBeenCalledTimes(1);
    // Argument is the response buffer (ArrayBuffer).
    const callArg = vi.mocked(pdfToText).mock.calls[0]![0];
    expect(callArg).toBeInstanceOf(ArrayBuffer);
  });

  it("routes PDF with charset/parameters in content-type", async () => {
    // application/pdf shouldn't carry a charset in practice, but some
    // misconfigured servers append parameters; classifyMime uses startsWith
    // so the routing must still pick the pdf path.
    vi.mocked(pdfToText).mockResolvedValueOnce("ok");
    mockFetchOnce({
      body: "%PDF-1.7",
      headers: { "content-type": "application/pdf; qs=0.9" },
    });
    const out = await fetchAsMarkdown({ url: "https://example.com/x.pdf" });
    expect(out).toBe("ok");
  });

  it("truncates pdftotext output to max_chars with footer", async () => {
    // Asserts the truncate() wiring is the same one the HTML/text paths use
    // — issue #119 explicitly notes max_chars should keep working without a
    // new per-page slicing parameter.
    vi.mocked(pdfToText).mockResolvedValueOnce("x".repeat(1000));
    mockFetchOnce({ body: "%PDF", headers: { "content-type": "application/pdf" } });
    const out = await fetchAsMarkdown({ url: "https://example.com/x.pdf", max_chars: 50 });
    expect(out).toMatch(/\[TRUNCATED — returned chars 0\.\.50 of 1000 total\. Re-call with offset=50/);
    expect(out.length).toBeLessThanOrEqual(50 + 200);
  });

  it("throws PDF error when pdftotext returns null at runtime (failure path)", async () => {
    // Mirrors the "pdftotext present but failed" path: pdf.ts swallows the
    // failure to null, fetchAsMarkdown must still surface the historical
    // error rather than leaking a half-empty success.
    vi.mocked(pdfToText).mockResolvedValueOnce(null);
    mockFetchOnce({ body: "%PDF", headers: { "content-type": "application/pdf" } });
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

  // Issue #135: content-negotiated markdown.
  // ACCEPT_HEADER is pinned to a literal so a future "let's simplify the
  // header" change has to acknowledge what it's deleting. The order and
  // q-values matter: markdown first (no q → q=1.0), HTML at q=0.9 so a
  // compliant server prefers markdown but never downgrades to */* when both
  // are available, and XHTML/XML kept for the handful of XHTML-strict sites.
  it("ACCEPT_HEADER prefers markdown over HTML (issue #135)", () => {
    expect(ACCEPT_HEADER).toBe(
      "text/markdown,text/html;q=0.9,application/xhtml+xml;q=0.9,application/xml;q=0.8,*/*;q=0.7",
    );
  });

  it("sends the markdown-preferring Accept header on every request", async () => {
    mockFetchOnce({ body: "<h1>Hi</h1>" });
    await fetchAsMarkdown({ url: "https://example.com" });
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1]!;
    const headers = new Headers(init.headers);
    expect(headers.get("accept")).toBe(ACCEPT_HEADER);
  });

  it("text/markdown response is returned verbatim and bypasses htmlToMarkdown (issue #135)", async () => {
    // Server honored Accept: text/markdown and returned pre-rendered markdown.
    // Must NOT route through pandoc/trafilatura — the whole point of the
    // preference is to skip that pipeline. classifyMime sends text/* to the
    // verbatim text branch.
    const md = "# Heading\n\nA paragraph with [a link](https://example.com).";
    mockFetchOnce({ body: md, headers: { "content-type": "text/markdown; charset=utf-8" } });
    const out = await fetchAsMarkdown({ url: "https://docs.example.com/page" });
    expect(out).toBe(md);
    expect(htmlToMarkdown).not.toHaveBeenCalled();
    expect(extractContent).not.toHaveBeenCalled();
  });

  it("text/html response (server ignored markdown preference) still goes through extractor + pandoc", async () => {
    // Regression test for the 70%+ of sites that ignore Accept: text/markdown
    // and serve HTML. The existing extraction pipeline must run unchanged
    // — the Accept header change is a preference, not a contract. Body must
    // be ≥ 10 KB to clear the small-body extractor bypass in webfetch.ts.
    const filler = "<p>" + "x".repeat(11_000) + "</p>";
    mockFetchOnce({ body: `<h1>Hello</h1>${filler}`, headers: { "content-type": "text/html" } });
    const out = await fetchAsMarkdown({ url: "https://example.com" });
    expect(out).toContain("MD:"); // htmlToMarkdown mock prefix
    expect(extractContent).toHaveBeenCalledTimes(1);
    expect(htmlToMarkdown).toHaveBeenCalledTimes(1);
  });

  it("truncates output to max_chars with footer naming the next offset (issue #132)", async () => {
    const longHtml = "<p>" + "x".repeat(100) + "</p>";
    mockFetchOnce({ body: longHtml });
    const md = await fetchAsMarkdown({ url: "https://example.com", max_chars: 5 });
    expect(md.length).toBeLessThanOrEqual(5 + 200); // body + footer
    expect(md).toMatch(/\[TRUNCATED — returned chars 0\.\.5 of \d+ total\. Re-call with offset=5/);
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
      // Post-redirect (final) URL, normalized by `URL` — `https://example.com`
      // round-trips to `https://example.com/`. Pin the normalized form so a
      // future regression that reverts to the pre-redirect input.url is loud.
      "https://example.com/",
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

// Build a chrome-only HTML shell where the extractor's output (mocked via
// tests) is suspect: passes the > 10 KB extractor gate but is < 1% of body
// size, triggering the looksThin branch in fetchAsMarkdown. Module-scope so
// it's not recreated on every call inside the describe (oxlint rule
// no-loop-func / hoist-stable-helpers).
function shellHtml(alternateTag: string): string {
  return "<html><head>" + alternateTag + "</head><body>" + "x".repeat(20_000) + "</body></html>";
}

// Issue #128: when extraction is thin, follow a same-origin <link
// rel="alternate"> in <head> with an allowlisted media type. Concrete
// motivating case is YouTube's oEmbed endpoint surfacing title/author/etc.
// when the watch-page HTML is a JS shell or login interstitial.
describe("thin-extraction <link rel=alternate> fallback (issue #128)", () => {
  const OEMBED_JSON_HREF = "https://example.com/oembed.json";

  // Sequence-aware fetch mock: pop a Response per call. Distinct from
  // mockFetchOnce because the alternate path issues two HTTP fetches.
  // No per-call cleanup needed: the file-level afterEach
  // (`vi.unstubAllGlobals()`) restores `fetch` between tests, so a leaked
  // sequence here can't reach the next test.
  function mockFetchSequence(
    responses: Array<{
      status?: number;
      headers?: Record<string, string>;
      body?: string | Uint8Array;
    }>,
  ): ReturnType<typeof vi.fn> {
    const fn = vi.fn();
    for (const r of responses) {
      const headers = new Headers(r.headers ?? { "content-type": "text/html; charset=utf-8" });
      const body = r.body ?? "";
      const responseBody: BodyInit = typeof body === "string" ? body : new Uint8Array(body);
      fn.mockResolvedValueOnce(new Response(responseBody, { status: r.status ?? 200, headers }));
    }
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("follows an oEmbed JSON alternate when extraction is thin", async () => {
    // Page extraction returns ~tiny output for a 20 KB body: looksThin fires.
    vi.mocked(extractContent).mockResolvedValueOnce("<p>tiny</p>");
    const html = shellHtml(
      `<link rel="alternate" type="application/json+oembed" href="${OEMBED_JSON_HREF}" title="Rick">`,
    );
    const fetchMock = mockFetchSequence([
      { body: html },
      {
        body: '{"title":"Rick Astley","author_name":"Rick Astley"}',
        headers: { "content-type": "application/json" },
      },
    ]);
    const out = await fetchAsMarkdown({ url: "https://example.com/watch?v=x" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second fetch hit the oEmbed URL exactly. fetchWithRedirects passes a
    // URL object to fetch, not a string — assert against URL directly so a
    // future shape change (e.g. Request) is a loud test failure rather than
    // a silent toString match.
    const altCall = fetchMock.mock.calls[1]![0];
    expect(altCall).toBeInstanceOf(URL);
    if (!(altCall instanceof URL)) throw new Error("unreachable");
    expect(altCall.href).toBe(OEMBED_JSON_HREF);
    // Output is the formatted oEmbed JSON, not the thin-extraction markdown.
    expect(out).toContain("```json");
    expect(out).toContain('"title": "Rick Astley"');
    // htmlToMarkdown was bypassed entirely on the success path.
    expect(htmlToMarkdown).not.toHaveBeenCalled();
  });

  it("falls back to thin extraction on a cross-origin alternate (open-redirector defense)", async () => {
    // A page can advertise an alternate at any URL; following cross-origin
    // alternates would turn webfetch into an open redirector for the page
    // author. This is the same-origin filter under test.
    vi.mocked(extractContent).mockResolvedValueOnce("<p>tiny</p>");
    const html = shellHtml(
      `<link rel="alternate" type="application/json+oembed" href="https://attacker.example/o.json">`,
    );
    const fetchMock = mockFetchSequence([{ body: html }]);
    await fetchAsMarkdown({ url: "https://example.com/watch?v=x" });
    // Only the original page was fetched; the alternate URL was rejected.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // We fell back to converting the full HTML.
    expect(htmlToMarkdown).toHaveBeenCalled();
  });

  it("is unchanged when no alternate link is present", async () => {
    vi.mocked(extractContent).mockResolvedValueOnce("<p>tiny</p>");
    const html = shellHtml("");
    const fetchMock = mockFetchSequence([{ body: html }]);
    await fetchAsMarkdown({ url: "https://example.com/watch?v=x" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(htmlToMarkdown).toHaveBeenCalledWith(html);
  });

  it("never follows an alternate when extraction is healthy (no extra HTTP)", async () => {
    // Happy path: extracted is >= 1% of body. looksThin must be false so
    // the alternate is never even considered — this is the cost-control
    // contract for the 95% of pages where extraction works.
    const fullHtml = shellHtml(
      `<link rel="alternate" type="application/json+oembed" href="${OEMBED_JSON_HREF}">`,
    );
    const extracted = "<article>" + "y".repeat(1_500) + "</article>"; // > 1% of 20 KB
    vi.mocked(extractContent).mockResolvedValueOnce(extracted);
    const fetchMock = mockFetchSequence([{ body: fullHtml }]);
    await fetchAsMarkdown({ url: "https://example.com/watch?v=x" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(htmlToMarkdown).toHaveBeenCalledWith(extracted);
  });

  it("falls back to thin extraction when the alternate returns HTTP 4xx", async () => {
    // First-match-wins: a failed oEmbed fetch does NOT trigger trying the
    // next alternate. We surrender to the thin-extraction markdown.
    vi.mocked(extractContent).mockResolvedValueOnce("<p>tiny</p>");
    const html = shellHtml(
      `<link rel="alternate" type="application/json+oembed" href="${OEMBED_JSON_HREF}">`,
    );
    const fetchMock = mockFetchSequence([
      { body: html },
      { status: 404, body: "not found", headers: { "content-type": "text/plain" } },
    ]);
    await fetchAsMarkdown({ url: "https://example.com/watch?v=x" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(htmlToMarkdown).toHaveBeenCalledWith(html);
  });

  it("skips disallowed alternate types (RSS) and follows the next allowed one", async () => {
    // findAlternates returns RSS entries too; the call site filters via
    // the allowlist. Three entries pin first-match-wins ordering end-to-
    // end: RSS (denied) → oEmbed JSON (allowed, fetched) → markdown
    // (allowed, must NOT be fetched). The mock sequence has only two
    // entries, so a regression that fetches the third would throw.
    vi.mocked(extractContent).mockResolvedValueOnce("<p>tiny</p>");
    const html = shellHtml(
      `<link rel="alternate" type="application/rss+xml" href="https://example.com/feed.rss">` +
        `<link rel="alternate" type="application/json+oembed" href="${OEMBED_JSON_HREF}">` +
        `<link rel="alternate" type="text/markdown" href="https://example.com/post.md">`,
    );
    const fetchMock = mockFetchSequence([
      { body: html },
      { body: '{"ok":true}', headers: { "content-type": "application/json" } },
    ]);
    const out = await fetchAsMarkdown({ url: "https://example.com/watch?v=x" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const altCall = fetchMock.mock.calls[1]![0];
    expect(altCall).toBeInstanceOf(URL);
    if (!(altCall instanceof URL)) throw new Error("unreachable");
    expect(altCall.href).toBe(OEMBED_JSON_HREF);
    expect(out).toContain('"ok": true');
  });

  it("resolves a relative alternate href against the page URL", async () => {
    // YouTube ships absolute hrefs, but other oEmbed providers (Substack,
    // self-hosted WordPress) often use relative paths. Resolution against
    // the page URL must keep the result same-origin.
    vi.mocked(extractContent).mockResolvedValueOnce("<p>tiny</p>");
    const html = shellHtml(
      `<link rel="alternate" type="application/json+oembed" href="/api/oembed.json">`,
    );
    const fetchMock = mockFetchSequence([
      { body: html },
      { body: '{"x":1}', headers: { "content-type": "application/json" } },
    ]);
    await fetchAsMarkdown({ url: "https://example.com/post/hello" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const altCall = fetchMock.mock.calls[1]![0];
    expect(altCall).toBeInstanceOf(URL);
    if (!(altCall instanceof URL)) throw new Error("unreachable");
    expect(altCall.href).toBe("https://example.com/api/oembed.json");
  });

  it("falls back when a same-origin alternate redirects cross-origin", async () => {
    // The same-origin filter is enforced on the advertised href, but
    // fetchWithRedirects follows redirects — so a same-origin alternate
    // that 302s to attacker.example would be followed without a post-
    // redirect re-check. Pin that re-check: the cross-origin Location
    // throws inside fetchWithRedirects and we surrender to thin extraction.
    vi.mocked(extractContent).mockResolvedValueOnce("<p>tiny</p>");
    const html = shellHtml(
      `<link rel="alternate" type="application/json+oembed" href="${OEMBED_JSON_HREF}">`,
    );
    const fetchMock = mockFetchSequence([
      { body: html },
      { status: 302, headers: { location: "https://attacker.example/o.json" }, body: "" },
    ]);
    await fetchAsMarkdown({ url: "https://example.com/watch?v=x" });
    // The redirect target is never fetched: only the original page and the
    // (rejected) same-origin alternate. We then fall back to thin extraction.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(htmlToMarkdown).toHaveBeenCalledWith(html);
  });

  it("resolves a relative alternate against the post-redirect URL (not input.url)", async () => {
    // Regression for the redirect-origin gap flagged in PR #134 review:
    // pageOrigin used to be derived from input.url, so a relative alternate
    // href on a redirected page would resolve against the wrong origin and
    // an absolute alternate on the post-redirect host would be rejected as
    // cross-origin. fetchWithRedirects now hands back finalUrl and that's
    // what the alternate path uses.
    //
    // Sequence: GET https://example.com/post → 302 to https://www.example.com/post
    //           GET https://www.example.com/post → thin shell with relative
    //                                                alternate href="/api/oembed.json"
    //           GET https://www.example.com/api/oembed.json → oEmbed JSON
    vi.mocked(extractContent).mockResolvedValueOnce("<p>tiny</p>");
    const html = shellHtml(
      `<link rel="alternate" type="application/json+oembed" href="/api/oembed.json">`,
    );
    const fetchMock = mockFetchSequence([
      { status: 302, headers: { location: "https://www.example.com/post" }, body: "" },
      { body: html },
      { body: '{"ok":true}', headers: { "content-type": "application/json" } },
    ]);
    const out = await fetchAsMarkdown({ url: "https://example.com/post" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const altCall = fetchMock.mock.calls[2]![0];
    expect(altCall).toBeInstanceOf(URL);
    if (!(altCall instanceof URL)) throw new Error("unreachable");
    // Resolved against the post-redirect host, not example.com.
    expect(altCall.href).toBe("https://www.example.com/api/oembed.json");
    expect(out).toContain('"ok": true');
  });

  it("skips a cross-origin alternate and follows the next same-origin allowed entry", async () => {
    // Pre-HTTP filters (cross-origin in particular) `continue` to the next
    // entry instead of bailing out — the asymmetry note in tryFollowAlternate
    // documents this. None of the other 7 tests exercise the
    // `[cross-origin allowed-type, same-origin allowed-type]` ordering, so
    // this pins it: the cross-origin entry is skipped without a request,
    // and the same-origin entry is fetched.
    vi.mocked(extractContent).mockResolvedValueOnce("<p>tiny</p>");
    const html = shellHtml(
      `<link rel="alternate" type="application/json+oembed" href="https://other.example/o.json">` +
        `<link rel="alternate" type="application/json+oembed" href="${OEMBED_JSON_HREF}">`,
    );
    const fetchMock = mockFetchSequence([
      { body: html },
      { body: '{"ok":true}', headers: { "content-type": "application/json" } },
    ]);
    const out = await fetchAsMarkdown({ url: "https://example.com/watch?v=x" });
    // Two calls total: page + same-origin alternate. The cross-origin
    // entry never hits the network (would be call #2 if we'd bailed instead
    // of continuing).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const altCall = fetchMock.mock.calls[1]![0];
    expect(altCall).toBeInstanceOf(URL);
    if (!(altCall instanceof URL)) throw new Error("unreachable");
    expect(altCall.href).toBe(OEMBED_JSON_HREF);
    expect(out).toContain('"ok": true');
  });

  it("keeps a short-but-passing extraction instead of following an alternate", async () => {
    // Regression for the looksThin gate (PR #134 review): a 150-char
    // extraction on a 10 KB body is 1.5% — above the 1% floor, so
    // useExtracted is true and the content is genuinely correct (just
    // short). The earlier `extracted.length < 200` OR-branch would have
    // discarded it and replaced it with an oEmbed stub. The `&&` form
    // pins the protective behavior: zero alternate fetches, and the
    // 150-char extraction is what's converted to markdown.
    const shortBody =
      "<html><head>" +
      `<link rel="alternate" type="application/json+oembed" href="${OEMBED_JSON_HREF}">` +
      "</head><body>" +
      "x".repeat(10_000) +
      "</body></html>";
    const extracted = "<article>" + "y".repeat(140) + "</article>"; // 158 chars, ~1.5% of 10 KB
    vi.mocked(extractContent).mockResolvedValueOnce(extracted);
    const fetchMock = mockFetchSequence([{ body: shortBody }]);
    await fetchAsMarkdown({ url: "https://example.com/watch?v=x" });
    // No alternate fetch — just the page itself.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(htmlToMarkdown).toHaveBeenCalledWith(extracted);
  });

  it("pins the && semantics at the exact boundary (199 chars, 1% gate just passes)", async () => {
    // Boundary regression for the `&& extracted.length < 200` half of the
    // looksThin gate (PR #134 review): a future refactor to `||` would
    // discard a 199-char extraction even when the 1% gate already passed,
    // surfacing an oEmbed stub in place of legitimate-but-short content.
    //
    // Construction: 199-char extraction on a body sized so that
    //   199 >= 0.01 * body.length        (1% gate passes → useExtracted=true)
    //   199 < 200                         (length floor would trigger alone)
    // Both gates are wired with `&&`, so looksThin is false and zero alt
    // fetches happen. With `||`, length<200 would dominate — alt would fire.
    const extracted = "<article>" + "y".repeat(199 - "<article></article>".length) + "</article>";
    expect(extracted).toHaveLength(199);
    // Pad body so total length sits at exactly 19_800 chars: 199/19_800 ≈
    // 1.005% — the 1% gate passes by ~1 char of headroom. Tightest
    // boundary that still proves the AND semantics.
    const targetBodyLen = 19_800;
    const head =
      "<html><head>" +
      `<link rel="alternate" type="application/json+oembed" href="${OEMBED_JSON_HREF}">` +
      "</head><body>";
    const tail = "</body></html>";
    const shortBody = head + "x".repeat(targetBodyLen - head.length - tail.length) + tail;
    expect(shortBody).toHaveLength(targetBodyLen);
    expect(extracted.length).toBeGreaterThanOrEqual(0.01 * shortBody.length); // 1% gate passes
    expect(extracted.length).toBeLessThan(200); // length floor would trigger alone
    vi.mocked(extractContent).mockResolvedValueOnce(extracted);
    const fetchMock = mockFetchSequence([{ body: shortBody }]);
    await fetchAsMarkdown({ url: "https://example.com/watch?v=x" });
    // No alternate fetch: useExtracted is true (1% gate), so looksThin is
    // false regardless of the < 200 floor. An accidental `||` would also
    // pass length check (199 < 200) and trigger an alternate fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(htmlToMarkdown).toHaveBeenCalledWith(extracted);
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

describe("looksLikeJsShell (issue #129)", () => {
  // Helper is marker-presence-only (no prefix-window slice); the body-size
  // half of the AND lives in the caller. These tests pin both halves of that
  // contract.
  it.each([
    "JavaScript is not available.",
    "Please enable JavaScript to continue.",
    "You need to enable JavaScript to run this app.",
    "This website requires JavaScript to function.",
  ])("matches marker phrase: %s", (phrase) => {
    expect(looksLikeJsShell(`<html><body>${phrase}</body></html>`)).toBe(true);
  });

  it.each([
    "javascript IS NOT available",
    "PLEASE ENABLE JAVASCRIPT to continue",
    "You Need To Enable JavaScript To Run This App",
    "THIS WEBSITE REQUIRES JAVASCRIPT to function",
  ])("is case-insensitive: %s", (phrase) => {
    // Parametrized over every marker so a future addition without `/i` fails
    // here instead of silently shipping a case-sensitive matcher.
    expect(looksLikeJsShell(phrase)).toBe(true);
  });

  it("returns false when no marker present", () => {
    expect(looksLikeJsShell("A perfectly normal article about web development.")).toBe(false);
  });

  it("matches even when marker sits deep in input (no prefix-window slice)", () => {
    // Direct callers can pass arbitrarily large input; the helper has no
    // sniff window of its own — the AND gate's < 2 KB size cap upstream is
    // what bounds deep-body false positives through fetchAsMarkdown.
    const padding = "x".repeat(5000) + " ";
    expect(looksLikeJsShell(`${padding}JavaScript is not available`)).toBe(true);
  });

  it("matches at the very start of input", () => {
    expect(looksLikeJsShell("JavaScript is not available somewhere")).toBe(true);
  });

  // Tightened post-review: bare "please enable JavaScript" is too common in
  // legit <noscript> fragments. Require an imperative tail.
  it("does NOT match bare 'please enable JavaScript' without imperative tail", () => {
    expect(
      looksLikeJsShell("Some features may not work. Please enable JavaScript. (legacy notice)"),
    ).toBe(false);
  });

  it("matches Twitter/X-style 'and Cookies to continue' phrasing", () => {
    expect(looksLikeJsShell("Please enable JavaScript and Cookies to continue using X.")).toBe(
      true,
    );
  });
});

describe("JS-only shell detection in fetchAsMarkdown (issue #129)", () => {
  it("throws JS-only shell error when markdown is short and contains marker", async () => {
    vi.mocked(htmlToMarkdown).mockResolvedValueOnce(
      "JavaScript is not available. We've detected that JavaScript is disabled.",
    );
    mockFetchOnce({ body: "<html><body>shell</body></html>" });
    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(
      /Site requires JS, cannot fetch in shell-only mode \(JS-only shell\)/,
    );
  });

  it("does NOT throw when markdown is large even if it mentions the marker phrase", async () => {
    // Real article that happens to discuss JS-disabled UX in a sidebar.
    // Marker at offset 0 — size gate alone must reject this.
    const longBody =
      "Please enable JavaScript to view comments. " + "Lorem ipsum dolor sit amet. ".repeat(200);
    vi.mocked(htmlToMarkdown).mockResolvedValueOnce(longBody);
    mockFetchOnce({ body: "<html><body>real article</body></html>" });
    const md = await fetchAsMarkdown({ url: "https://example.com" });
    expect(md).toContain("Lorem ipsum");
  });

  it("does NOT throw when markdown is large with the marker buried past 4 KB", async () => {
    // Sibling of the above: marker at offset > 4096 in a > 2 KB body. Locks
    // the size gate independently of marker position — the previous test
    // could in principle have passed via a position-based short-circuit; this
    // one can only pass via the size gate.
    const padding = "Lorem ipsum dolor sit amet. ".repeat(200); // ~5.4 KB
    const longBody = padding + "Please enable JavaScript to continue.";
    expect(longBody.indexOf("Please enable JavaScript")).toBeGreaterThan(4096);
    vi.mocked(htmlToMarkdown).mockResolvedValueOnce(longBody);
    mockFetchOnce({ body: "<html><body>real article</body></html>" });
    const md = await fetchAsMarkdown({ url: "https://example.com" });
    expect(md).toContain("Lorem ipsum");
  });

  it("throws when marker survives only in raw body (extractor stripped live-DOM text)", async () => {
    // trafilatura/Readability can drop near-empty bodies down to a loading
    // string, leaving an extracted-then-html2md output that's marker-free even
    // though the upstream HTML's *visible* DOM is a textbook SPA shell.
    // Without the raw-body fallback the caller would receive a tiny blank
    // string instead of the actionable JS-only shell error.
    //
    // Marker lives in a real DOM node (not <noscript>) on purpose: the body
    // fallback strips <noscript> before scanning, so a CRA/Next default
    // template's <noscript>You need to enable JavaScript…</noscript> on an
    // otherwise-real page must NOT trip the shell error. See companion
    // negative test below.
    vi.mocked(htmlToMarkdown).mockResolvedValueOnce("Loading\u2026");
    mockFetchOnce({
      body: "<html><body><div id='app'>JavaScript is not available.</div></body></html>",
    });
    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(
      /Site requires JS, cannot fetch in shell-only mode \(JS-only shell\)/,
    );
  });

  it("does NOT throw when marker only appears inside <noscript> (CRA/Next default)", async () => {
    // Every CRA/Next scaffold ships <noscript>You need to enable JavaScript
    // to run this app</noscript>. If extraction degenerates (md < 2 KB) on
    // a legit page, the body fallback must not turn that boilerplate into
    // an actionable error — only shells whose *visible* DOM is the marker
    // should trip. Pins the scrub regex in the body-fallback path.
    vi.mocked(htmlToMarkdown).mockResolvedValueOnce("Welcome.");
    mockFetchOnce({
      body: "<html><body><noscript>You need to enable JavaScript to run this app.</noscript><main>Welcome.</main></body></html>",
    });
    const md = await fetchAsMarkdown({ url: "https://example.com" });
    expect(md).toContain("Welcome");
  });

  it("does NOT throw on short markdown without marker (e.g. tiny status page)", async () => {
    // Short body but no JS-shell marker — a 200-char status page is legit.
    vi.mocked(htmlToMarkdown).mockResolvedValueOnce("Service unavailable. Try again later.");
    mockFetchOnce({ body: "<html><body>status</body></html>" });
    const md = await fetchAsMarkdown({ url: "https://example.com" });
    expect(md).toContain("Service unavailable");
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

describe("Retry-After honoring (issue #121)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries once after Retry-After: 1 on 429 and succeeds", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: new Headers({ "content-type": "text/plain", "retry-after": "1" }),
        }),
      )
      .mockResolvedValueOnce(
        new Response("<h1>OK</h1>", {
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
        }),
      );
    vi.stubGlobal("fetch", mock);

    const promise = fetchAsMarkdown({ url: "https://example.com" });
    // Drain microtasks so the first response is observed and the sleep starts,
    // then advance the fake clock by exactly the requested wait — exercises
    // the "sleep at least Retry-After ms" contract, not just "≥ wait".
    await vi.advanceTimersByTimeAsync(1_000);
    const md = await promise;
    expect(mock).toHaveBeenCalledTimes(2);
    expect(md).toContain("MD:");
  });

  it("retries once after Retry-After: 1 on 503 and succeeds", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("unavailable", {
          status: 503,
          headers: new Headers({ "content-type": "text/plain", "retry-after": "1" }),
        }),
      )
      .mockResolvedValueOnce(
        new Response("<h1>OK</h1>", {
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
        }),
      );
    vi.stubGlobal("fetch", mock);

    const promise = fetchAsMarkdown({ url: "https://example.com" });
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("does not retry when Retry-After exceeds the cap", async () => {
    const overCap = String(Math.ceil(RETRY_AFTER_MAX_MS / 1000) + 5);
    const mock = vi.fn().mockResolvedValueOnce(
      new Response("slow down", {
        status: 503,
        headers: new Headers({
          "content-type": "text/plain",
          "retry-after": overCap,
        }),
      }),
    );
    vi.stubGlobal("fetch", mock);

    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(/HTTP 503/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("does not retry when Retry-After is missing", async () => {
    const mock = vi.fn().mockResolvedValueOnce(
      new Response("slow down", {
        status: 429,
        headers: new Headers({ "content-type": "text/plain" }),
      }),
    );
    vi.stubGlobal("fetch", mock);

    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(/HTTP 429/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("does not retry when Retry-After is malformed", async () => {
    const mock = vi.fn().mockResolvedValueOnce(
      new Response("slow down", {
        status: 429,
        headers: new Headers({ "content-type": "text/plain", "retry-after": "soon" }),
      }),
    );
    vi.stubGlobal("fetch", mock);

    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(/HTTP 429/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("throws on a second 429 — only one retry", async () => {
    const headers429 = { "content-type": "text/plain", "retry-after": "1" };
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: new Headers(headers429) }),
      )
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: new Headers(headers429) }),
      );
    vi.stubGlobal("fetch", mock);

    const promise = fetchAsMarkdown({ url: "https://example.com" });
    // Surface the rejection to the test runner so an unhandled rejection from
    // the awaited timer advance doesn't fail the suite before the assertion.
    const result = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    const err = await result;
    expect(err).toBeInstanceOf(Error);
    expect(err instanceof Error ? err.message : String(err)).toMatch(/HTTP 429/);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 502 / 504 (out of scope per issue #121)", async () => {
    for (const status of [502, 504]) {
      const mock = vi.fn().mockResolvedValueOnce(
        new Response("bad gw", {
          status,
          headers: new Headers({ "content-type": "text/plain", "retry-after": "1" }),
        }),
      );
      vi.stubGlobal("fetch", mock);
      await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(
        new RegExp(`HTTP ${status}`),
      );
      expect(mock).toHaveBeenCalledTimes(1);
    }
  });

  it("reuses the OPENCODE UA on retry after a CF UA-swap", async () => {
    // First hop: CF challenge with BROWSER_UA. Second hop: OPENCODE_UA gets
    // past CF but the upstream returns 429+Retry-After. Third hop must reuse
    // OPENCODE_UA, not reset to BROWSER_UA — otherwise CF would re-challenge.
    const cfHeaders = new Headers({ "content-type": "text/html", "cf-mitigated": "challenge" });
    const mock = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>cf</html>", { status: 200, headers: cfHeaders }))
      .mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: new Headers({ "content-type": "text/plain", "retry-after": "1" }),
        }),
      )
      .mockResolvedValueOnce(
        new Response("<h1>OK</h1>", {
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
        }),
      );
    vi.stubGlobal("fetch", mock);

    const promise = fetchAsMarkdown({ url: "https://example.com" });
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;
    expect(mock).toHaveBeenCalledTimes(3);
    // OPENCODE_UA on hop 2 (CF retry) and hop 3 (Retry-After retry).
    // Defensively assert the headers slot exists: if fetchWithRedirects ever
    // switches to a Headers instance, plain-object indexing silently yields
    // undefined and the .toBe assertions would still "pass" against the
    // wrong polarity.
    const hop2 = mock.mock.calls[1]![1];
    const hop3 = mock.mock.calls[2]![1];
    expect(hop2.headers).toBeDefined();
    expect(hop3.headers).toBeDefined();
    expect(hop2.headers["User-Agent"]).toBe("opencode");
    expect(hop3.headers["User-Agent"]).toBe("opencode");
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
      /\[TRUNCATED — returned chars 0\.\.100 of 1000 total\. Re-call with offset=100 to read the next chunk\.\]/,
    );
  });

  it("returns mid-document slice with footer citing the correct next offset", () => {
    const text = "x".repeat(1000);
    const out = paginate(text, 200, 300);
    expect(out.startsWith("x".repeat(300))).toBe(true);
    expect(out).toMatch(/returned chars 200\.\.500 of 1000 total/);
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
    expect(out).toMatch(/Re-call with offset=0/);
  });

  it("past-end marker fires for offset strictly greater than length too", () => {
    const out = paginate("hello", 999, 50);
    expect(out).toMatch(/OFFSET 999 PAST END/);
  });
});
