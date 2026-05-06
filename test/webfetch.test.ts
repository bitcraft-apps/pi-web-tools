import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/lib/html2md.js", () => ({
  htmlToMarkdown: vi.fn(async (html: string) => `MD:${html.slice(0, 20)}`),
}));

import { fetchAsMarkdown } from "../src/webfetch.js";

function mockFetchOnce(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}) {
  const headers = new Headers(opts.headers ?? { "content-type": "text/html; charset=utf-8" });
  const status = opts.status ?? 200;
  global.fetch = vi.fn().mockResolvedValueOnce(
    new Response(opts.body ?? "<h1>Hi</h1>", { status, headers })
  ) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchAsMarkdown", () => {
  it("blocks non-http schemes via url-guard", async () => {
    await expect(fetchAsMarkdown({ url: "ftp://example.com" })).rejects.toThrow(/scheme/i);
  });

  it("blocks localhost", async () => {
    await expect(fetchAsMarkdown({ url: "http://localhost:3000" })).rejects.toThrow(/blocked host/i);
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
    await expect(fetchAsMarkdown({ url: "https://example.com/x.pdf" })).rejects.toThrow(/cannot fetch.*pdf/i);
  });

  it("throws on image/*", async () => {
    mockFetchOnce({ body: "...", headers: { "content-type": "image/png" } });
    await expect(fetchAsMarkdown({ url: "https://example.com/x.png" })).rejects.toThrow(/cannot fetch.*image/i);
  });

  it("throws on HTTP 404", async () => {
    mockFetchOnce({ status: 404, headers: { "content-type": "text/html" }, body: "<h1>Not Found</h1>" });
    await expect(fetchAsMarkdown({ url: "https://example.com/missing" })).rejects.toThrow(/HTTP 404/);
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
});

describe("Cloudflare retry hack", () => {
  it("retries with UA=opencode on cf-mitigated header", async () => {
    const cfHeaders = new Headers({ "content-type": "text/html", "cf-mitigated": "challenge" });
    const okHeaders = new Headers({ "content-type": "text/html" });

    const mock = vi.fn()
      .mockResolvedValueOnce(new Response("<html>blocked</html>", { status: 200, headers: cfHeaders }))
      .mockResolvedValueOnce(new Response("<h1>OK</h1>", { status: 200, headers: okHeaders }));
    global.fetch = mock as any;

    const md = await fetchAsMarkdown({ url: "https://example.com" });
    expect(mock).toHaveBeenCalledTimes(2);
    const secondCall = mock.mock.calls[1][1];
    expect(secondCall.headers["User-Agent"]).toBe("opencode");
    expect(md).toContain("MD:");
  });

  it("retries with UA=opencode on 403 + 'Just a moment' body", async () => {
    const headers = new Headers({ "content-type": "text/html" });
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response("<html>Just a moment...</html>", { status: 403, headers }))
      .mockResolvedValueOnce(new Response("<h1>OK</h1>", { status: 200, headers }));
    global.fetch = mock as any;

    await fetchAsMarkdown({ url: "https://example.com" });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("throws if challenge persists after retry", async () => {
    const cfHeaders = new Headers({ "content-type": "text/html", "cf-mitigated": "challenge" });
    const mock = vi.fn()
      .mockResolvedValue(new Response("<html>blocked</html>", { status: 200, headers: cfHeaders }));
    global.fetch = mock as any;

    await expect(fetchAsMarkdown({ url: "https://example.com" })).rejects.toThrow(/JS|cannot fetch/i);
  });
});
