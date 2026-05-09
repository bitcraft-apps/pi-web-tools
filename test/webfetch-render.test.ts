import { initTheme, keyHint } from "@mariozechner/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import {
  formatWebfetchCall,
  formatWebfetchResult,
  WEBFETCH_PREVIEW_MAX_LINES,
  type WebfetchToolDetails,
} from "../src/webfetch.js";
import { stubTheme } from "./_helpers/theme.js";

const theme = stubTheme();

// Arbitrary placeholder — formatter is opaque to the actual value; the
// real `keyHint("app.tools.expand", ...)` call site is exercised in the
// integration block below.
const EXPAND_HINT = "Ctrl+E";

const SAMPLE_BODY = ["# Title", "", "First paragraph.", "", "Second paragraph."].join("\n");
const SAMPLE_DETAILS: WebfetchToolDetails = {
  url: "https://example.com/path?x=1",
  chars: SAMPLE_BODY.length,
};

describe("formatWebfetchCall", () => {
  it("renders just the URL when only defaults are used", () => {
    expect(formatWebfetchCall({ url: "https://example.com/path" }, theme)).toBe(
      "webfetch https://example.com/path",
    );
  });

  it("includes max_chars muted when overridden", () => {
    expect(formatWebfetchCall({ url: "https://example.com/", max_chars: 10000 }, theme)).toBe(
      "webfetch https://example.com/ max_chars=10000",
    );
  });

  it("includes max_chars=0 even though execute will truncate to empty", () => {
    // 0 is a non-default override — user needs to see *why* the fetch
    // came back empty, not have it silently hidden.
    expect(formatWebfetchCall({ url: "https://example.com/", max_chars: 0 }, theme)).toBe(
      "webfetch https://example.com/ max_chars=0",
    );
  });

  it("omits max_chars when explicitly set to the default", () => {
    expect(formatWebfetchCall({ url: "https://example.com/", max_chars: 50000 }, theme)).toBe(
      "webfetch https://example.com/",
    );
  });

  it("survives missing/garbage args (streaming partials)", () => {
    // No URL → no trailing space; matters for copy/paste and snapshot diffs.
    expect(formatWebfetchCall(undefined, theme)).toBe("webfetch");
  });
});

describe("formatWebfetchResult", () => {
  it("collapsed view shows host+path with size+lines and expand hint, dropping query", () => {
    const out = formatWebfetchResult(
      {
        details: SAMPLE_DETAILS,
        body: SAMPLE_BODY,
        expanded: false,
        isError: false,
        expandHint: EXPAND_HINT,
      },
      theme,
    );
    // Query string is intentionally stripped from the collapsed header so
    // tokens/sigs in `?token=...` etc. don't leak into scrollback.
    // Body has 5 lines (4 newlines + trailing partial); expect "5 lines".
    expect(out).toMatch(/^✓ fetched example\.com\/path \(\d+B, ~5 lines\) \(Ctrl\+E\)$/);
    expect(out).not.toContain("?x=1");
  });

  it("collapsed view falls back to details.url when host parse fails", () => {
    const out = formatWebfetchResult(
      {
        details: { url: "not a url", chars: 0 },
        body: "",
        expanded: false,
        isError: false,
        expandHint: EXPAND_HINT,
      },
      theme,
    );
    expect(out).toContain("not a url");
    expect(out).toContain("0 lines");
  });

  it("expanded view under cap shows full body, no truncation footer", () => {
    const out = formatWebfetchResult(
      {
        details: SAMPLE_DETAILS,
        body: SAMPLE_BODY,
        expanded: true,
        isError: false,
        expandHint: EXPAND_HINT,
      },
      theme,
    );
    expect(out).toContain(SAMPLE_BODY);
    expect(out).not.toMatch(/\+\d+ more lines/);
  });

  it("expanded view over cap shows preview with truncation footer", () => {
    const lineCount = WEBFETCH_PREVIEW_MAX_LINES + 50;
    const body = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n");
    const out = formatWebfetchResult(
      {
        details: { url: "https://e.test/", chars: body.length },
        body,
        expanded: true,
        isError: false,
        expandHint: EXPAND_HINT,
      },
      theme,
    );
    const lines = out.split("\n");
    // Header + WEBFETCH_PREVIEW_MAX_LINES preview + footer.
    expect(lines).toHaveLength(WEBFETCH_PREVIEW_MAX_LINES + 2);
    expect(lines[1]).toBe("line 1");
    expect(lines[WEBFETCH_PREVIEW_MAX_LINES]).toBe(`line ${WEBFETCH_PREVIEW_MAX_LINES}`);
    expect(lines.at(-1)).toBe("… +50 more lines (full content was sent to the model)");
  });

  it("error path uses ✗ and the error text", () => {
    expect(
      formatWebfetchResult(
        {
          details: undefined,
          body: "",
          expanded: false,
          isError: true,
          errorText: "HTTP 404: Not Found",
          expandHint: EXPAND_HINT,
        },
        theme,
      ),
    ).toBe("✗ webfetch: HTTP 404: Not Found");
  });

  it("error path falls back to generic message when errorText is missing", () => {
    expect(
      formatWebfetchResult(
        {
          details: undefined,
          body: "",
          expanded: false,
          isError: true,
          expandHint: EXPAND_HINT,
        },
        theme,
      ),
    ).toBe("✗ webfetch: error");
  });

  it("missing details renders collapsed without crashing", () => {
    const out = formatWebfetchResult(
      {
        details: undefined,
        body: "hello\nworld",
        expanded: false,
        isError: false,
        expandHint: EXPAND_HINT,
      },
      theme,
    );
    // No URL → just the parenthesized stats; no crash.
    expect(out).toContain("2 lines");
    expect(out).toContain("Ctrl+E");
  });

  it("size formatting follows the read tool convention (B/KB/MB)", () => {
    const big = "x".repeat(2048); // 2048 bytes → "2.0KB"
    const out = formatWebfetchResult(
      {
        details: { url: "https://e.test/", chars: big.length },
        body: big,
        expanded: false,
        isError: false,
        expandHint: EXPAND_HINT,
      },
      theme,
    );
    expect(out).toContain("2.0KB");
  });

  it("prefers details.bytes over recomputing from body", () => {
    // Pin a fake byte count distinct from the body's real utf-8 length so
    // we can prove the renderer is using the cached value, not recomputing.
    const out = formatWebfetchResult(
      {
        details: { url: "https://e.test/", chars: 5, bytes: 4096 },
        body: "hello",
        expanded: false,
        isError: false,
        expandHint: EXPAND_HINT,
      },
      theme,
    );
    expect(out).toContain("4.0KB");
    expect(out).not.toContain("5B");
  });
});

// Mirrors the websearch keyHint integration test: keeps the live
// keyHint("app.tools.expand", ...) call site honest. See the matching
// block in test/websearch-render.test.ts for the rationale.
describe("keyHint integration", () => {
  beforeAll(() => {
    try {
      initTheme("dark");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `initTheme("dark") failed — pi-coding-agent's theme API may have changed: ${message}`,
        { cause: err },
      );
    }
  });

  it("the real keyHint accepts the expand binding and includes the description", () => {
    const hint = keyHint("app.tools.expand", "to expand");
    expect(typeof hint).toBe("string");
    expect(hint).toContain("to expand");
  });
});
