import { initTheme, keyHint } from "@mariozechner/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import {
  formatWebsearchCall,
  formatWebsearchResult,
  type WebsearchToolDetails,
} from "../src/websearch.js";
import { stubTheme } from "./_helpers/theme.js";

const theme = stubTheme();

// Arbitrary placeholder — the formatter is opaque to its actual value;
// the real `keyHint("app.tools.expand", ...)` call site is exercised in
// the integration block at the bottom of this file.
const EXPAND_HINT = "Ctrl+E";

const SAMPLE_RESULTS: NonNullable<WebsearchToolDetails["results"]> = [
  { title: "Example", url: "https://example.com", snippet: "first snippet" },
  { title: "Other", url: "https://other.test/path", snippet: "" },
];

const SAMPLE_DETAILS: WebsearchToolDetails = {
  query: "pierogi",
  results: SAMPLE_RESULTS,
};

describe("formatWebsearchCall", () => {
  it("renders just the query when only defaults are used", () => {
    expect(formatWebsearchCall({ query: "pierogi" }, theme)).toBe('websearch "pierogi"');
  });

  it("includes non-default args muted", () => {
    expect(
      formatWebsearchCall(
        { query: "pierogi", limit: 5, region: "pl-pl", safesearch: "off" },
        theme,
      ),
    ).toBe('websearch "pierogi" limit=5 region=pl-pl safesearch=off');
  });

  it("surfaces time when set", () => {
    expect(formatWebsearchCall({ query: "latest x", time: "w" }, theme)).toBe(
      'websearch "latest x" time=w',
    );
  });

  it("shows time alongside other muted extras in a stable order", () => {
    // Order matches the source insertion order: limit, region, safesearch, time.
    // Pinned by test so a future reorder is a deliberate choice, not an accident.
    expect(
      formatWebsearchCall(
        { query: "q", limit: 3, region: "de-de", safesearch: "off", time: "d" },
        theme,
      ),
    ).toBe('websearch "q" limit=3 region=de-de safesearch=off time=d');
  });

  it("omits limit when explicitly set to the default", () => {
    expect(formatWebsearchCall({ query: "x", limit: 8 }, theme)).toBe('websearch "x"');
  });

  it("omits safesearch when explicitly set to moderate", () => {
    expect(formatWebsearchCall({ query: "x", safesearch: "moderate" }, theme)).toBe(
      'websearch "x"',
    );
  });

  it("survives missing/garbage args (streaming partials)", () => {
    expect(formatWebsearchCall(undefined, theme)).toBe('websearch ""');
  });
});

describe("formatWebsearchResult", () => {
  it("collapsed view shows count + expand hint", () => {
    expect(
      formatWebsearchResult(
        { details: SAMPLE_DETAILS, expanded: false, isError: false, expandHint: EXPAND_HINT },
        theme,
      ),
    ).toBe('✓ 2 results for "pierogi" (Ctrl+E)');
  });

  it("collapsed view singularizes for count=1", () => {
    expect(
      formatWebsearchResult(
        {
          details: { query: "x", count: 1, results: [SAMPLE_RESULTS[0]!] },
          expanded: false,
          isError: false,
          expandHint: EXPAND_HINT,
        },
        theme,
      ),
    ).toBe('✓ 1 result for "x" (Ctrl+E)');
  });

  it("expanded view lists numbered results with title/url/snippet", () => {
    const out = formatWebsearchResult(
      { details: SAMPLE_DETAILS, expanded: true, isError: false, expandHint: EXPAND_HINT },
      theme,
    );
    expect(out).toBe(
      [
        '✓ 2 results for "pierogi"',
        "",
        "1. Example",
        "   https://example.com",
        "   first snippet",
        "",
        "2. Other",
        "   https://other.test/path",
      ].join("\n"),
    );
  });

  it("empty results render as warning, not as ✓", () => {
    expect(
      formatWebsearchResult(
        {
          details: { query: "nada", count: 0, results: [] },
          expanded: false,
          isError: false,
          expandHint: EXPAND_HINT,
        },
        theme,
      ),
    ).toBe('no results for "nada"');
  });

  it("error path uses ✗ and the error text", () => {
    expect(
      formatWebsearchResult(
        {
          details: undefined,
          expanded: false,
          isError: true,
          errorText: "ddgr not installed",
          expandHint: EXPAND_HINT,
        },
        theme,
      ),
    ).toBe("✗ websearch: ddgr not installed");
  });

  it("error path falls back to generic message when errorText is missing", () => {
    expect(
      formatWebsearchResult(
        { details: undefined, expanded: false, isError: true, expandHint: EXPAND_HINT },
        theme,
      ),
    ).toBe("✗ websearch: error");
  });

  it("missing details.results in expanded mode renders header-only (old session compat)", () => {
    expect(
      formatWebsearchResult(
        {
          details: { query: "old", count: 3 },
          expanded: true,
          isError: false,
          expandHint: EXPAND_HINT,
        },
        theme,
      ),
    ).toBe('✓ 3 results for "old"');
  });

  it("missing details entirely treats count as 0", () => {
    expect(
      formatWebsearchResult(
        { details: undefined, expanded: false, isError: false, expandHint: EXPAND_HINT },
        theme,
      ),
    ).toBe('no results for ""');
  });

  it("strips C0/ANSI escapes from ddgr-supplied title/url/snippet", () => {
    const out = formatWebsearchResult(
      {
        details: {
          query: "q",
          results: [
            {
              title: "Evil\x1b[2JTitle",
              url: "https://e.test\x07/path",
              snippet: "line1\nline2\x1b[31mred",
            },
          ],
        },
        expanded: true,
        isError: false,
        expandHint: EXPAND_HINT,
      },
      theme,
    );
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x07");
    expect(out).not.toContain("\nline2"); // newline inside snippet was stripped
    expect(out).toContain("EvilTitle");
    expect(out).toContain("https://e.test/path");
    expect(out).toContain("line1line2red");
  });

  it("quote() escapes embedded quotes/backslashes/control chars but keeps non-ASCII readable", () => {
    expect(formatWebsearchCall({ query: "привет" }, theme)).toBe('websearch "привет"');
    expect(formatWebsearchCall({ query: 'a"b\\c\x1bd' }, theme)).toBe(
      'websearch "a\\"b\\\\c\\x1bd"',
    );
  });
});

// The collapsed-view tests above feed `formatWebsearchResult` a fake
// `expandHint` so they never depend on the real keybinding registry.
// That's correct for the formatter contract, but it leaves the live
// `keyHint("app.tools.expand", ...)` call site in `websearch.ts`
// completely untested — if pi-coding-agent removed/renamed `keyHint`,
// or changed its signature, our renderer would crash at runtime and
// these tests would still pass.
//
// This case keeps the live call honest. Note: it does NOT catch a
// rename of the binding *id* itself ("app.tools.expand" → something
// else), because that would require deep-importing the binding
// registry from pi-coding-agent's internals (`core/keybindings.js`),
// which we don't want to couple to. A binding-id rename surfaces as
// an empty key prefix ("  to expand"), not a thrown error.
describe("keyHint integration", () => {
  beforeAll(() => {
    // keyHint() resolves theme colors via the global theme singleton,
    // which throws if uninitialized. Pin a known theme name ("dark" is
    // shipped by pi-coding-agent) instead of relying on the implicit
    // default — if the default ever requires an explicit name we get a
    // clear failure here rather than a flaky one downstream.
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
