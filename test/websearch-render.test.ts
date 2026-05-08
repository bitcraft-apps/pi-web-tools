import { describe, expect, it } from "vitest";
import {
  formatWebsearchCall,
  formatWebsearchResult,
  type WebsearchToolDetails,
} from "../src/websearch.js";
import { stubTheme } from "./_helpers/theme.js";

const theme = stubTheme();

const SAMPLE_RESULTS: NonNullable<WebsearchToolDetails["results"]> = [
  { title: "Example", url: "https://example.com", snippet: "first snippet" },
  { title: "Other", url: "https://other.test/path", snippet: "" },
];

const SAMPLE_DETAILS: WebsearchToolDetails = {
  query: "pierogi",
  count: 2,
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
        { details: SAMPLE_DETAILS, expanded: false, isError: false, expandHint: "Ctrl+E" },
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
          expandHint: "Ctrl+E",
        },
        theme,
      ),
    ).toBe('✓ 1 result for "x" (Ctrl+E)');
  });

  it("expanded view lists numbered results with title/url/snippet", () => {
    const out = formatWebsearchResult(
      { details: SAMPLE_DETAILS, expanded: true, isError: false, expandHint: "Ctrl+E" },
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
          expandHint: "Ctrl+E",
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
          expandHint: "Ctrl+E",
        },
        theme,
      ),
    ).toBe("✗ websearch: ddgr not installed");
  });

  it("error path falls back to generic message when errorText is missing", () => {
    expect(
      formatWebsearchResult(
        { details: undefined, expanded: false, isError: true, expandHint: "Ctrl+E" },
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
          expandHint: "Ctrl+E",
        },
        theme,
      ),
    ).toBe('✓ 3 results for "old"');
  });

  it("missing details entirely treats count as 0", () => {
    expect(
      formatWebsearchResult(
        { details: undefined, expanded: false, isError: false, expandHint: "Ctrl+E" },
        theme,
      ),
    ).toBe('no results for ""');
  });
});
