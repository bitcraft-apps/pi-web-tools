import { describe, it, expect, vi, afterEach } from "vitest";
import { mockFetchOnce, restoreFetch } from "./_helpers/fetch.js";
import { stubExtensionContext } from "./_helpers/context.js";

// The `execute` smoke test asserts the `MD:` prefix, so the converter stays
// mocked here. `extract` and `pdf` need no mock: the 11-char body is under the
// extractor's 10 KB floor and never reaches the PDF branch. Everything else
// about the pipeline is covered by test/pipeline.test.ts.
vi.mock("../src/lib/html2md.js", () => ({
  htmlToMarkdown: vi.fn(async (html: string) => `MD:${html.slice(0, 20)}`),
}));

import { webfetchTool } from "../src/webfetch.js";

afterEach(() => {
  restoreFetch();
});

describe("webfetchTool", () => {
  it("has correct shape", () => {
    expect(webfetchTool.name).toBe("webfetch");
    expect(webfetchTool.description).toMatch(/markdown/i);
    expect(typeof webfetchTool.execute).toBe("function");
  });

  // Regression guard for the real defect this block was added for: PDF
  // support landed in #126, but the description kept the pre-#126 sentence
  // "Cannot fetch binary content (PDF, images)" for eight months. The model
  // reads the description, so a working, tested feature was advertised as
  // unavailable. Assert the contradiction cannot come back.
  it("does not advertise PDFs as unfetchable, because they are fetchable", () => {
    expect(webfetchTool.description).not.toMatch(/cannot fetch binary content/i);
    // Narrow: only flags "cannot fetch ... pdf" phrasing, so the legitimate
    // "cannot fetch images" limit and the pdftotext caveat both still pass.
    expect(webfetchTool.description).not.toMatch(/cannot fetch[^.]*\bpdfs?\b/i);
    // ...and it states the real precondition rather than staying silent.
    expect(webfetchTool.description).toMatch(/pdftotext/i);
  });

  it("advertises itself to the default system prompt", () => {
    // pi omits custom tools from the "Available tools" section when
    // promptSnippet is absent, so a missing snippet is silent invisibility.
    expect(webfetchTool.promptSnippet).toBeTruthy();
    // pi collapses newlines itself; assert we hand it one line to begin with.
    expect(webfetchTool.promptSnippet).not.toMatch(/[\r\n]/);
    expect(webfetchTool.promptGuidelines?.length).toBeGreaterThan(0);
  });

  it("requests constrained sampling without depending on it", () => {
    // "prefer", never "require": providers lacking the capability must keep
    // working. A flip to "require" would make this tool provider-gated.
    expect(webfetchTool.constrainedSampling).toEqual({
      type: "json_schema",
      strict: "prefer",
    });
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

  it("treats explicit nulls as not supplied (#241)", async () => {
    // Strict mode forbids optional properties, so a Codex-driven session
    // sends null for args the model skipped. This is not cosmetic: pi does
    // not normalize args before execute, and a raw `offset: null` reaches
    // fetchAsMarkdown's integer guard and throws `Invalid offset: null` —
    // i.e. every default webfetch call on those providers would fail.
    mockFetchOnce({ body: "<h1>Hi</h1>" });
    const result = await webfetchTool.execute(
      "tc-nulls",
      { url: "https://example.com", max_chars: null, offset: null },
      new AbortController().signal,
      () => {},
      stubExtensionContext(),
    );
    const textContent = result.content[0]!;
    expect(textContent.type).toBe("text");
    if (textContent.type === "text") {
      expect(textContent.text).toContain("MD:");
      // No truncation footer: null max_chars fell back to the 50k default
      // rather than being passed through as a limit.
      expect(textContent.text).not.toMatch(/TRUNCATED/);
    }
  });
});
