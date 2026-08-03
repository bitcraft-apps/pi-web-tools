// Renders real `websearch` output to an ANSI string.
//
// Split from capture-websearch.ts so both consumers share one definition
// of "what the websearch preview shows":
//   - capture-websearch.ts  → writes it to websearch-output.ans (freeze)
//   - demo-cli.ts           → prints it to stdout (vhs)
// The PNG and the MP4 must show the same thing; that only holds if the
// query, limit, and theme live in exactly one place.

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { runDdgr } from "../../src/lib/ddgr.ts";
import { formatWebsearchResult } from "../../src/websearch.ts";
import { makeTheme } from "./ansi-theme.ts";

export const QUERY = "pi coding agent";
export const LIMIT = 5;

// Roles must cover every theme.fg(role, …) call reachable from
// formatWebsearchResult. If a future change to that formatter reaches
// for a role missing here, makeTheme's guard throws — drift fails
// loudly instead of degrading the fixture.
const SGR_FG: Partial<Record<ThemeColor, string>> = {
  accent: "\x1b[38;5;39m", // bright cyan-blue, links/titles
  dim: "\x1b[38;5;245m", // gray, urls
  success: "\x1b[38;5;42m", // green, ✓ header
  warning: "\x1b[38;5;214m",
  error: "\x1b[38;5;203m",
};

const theme = makeTheme("render-websearch.ts", SGR_FG);

/**
 * Live ddgr query + render. Throws (non-zero via tsx) on network or
 * ddgr failure.
 *
 * `query` and `limit` are parameters, not hard-coded constants, because
 * demo.tape types them on screen and must actually run what it typed —
 * the video shows a smaller `--limit` so the results fit the frame
 * without scrolling. They default to QUERY/LIMIT so capture-websearch.ts
 * keeps producing exactly the fixture the PNG was rendered from.
 */
export async function renderWebsearch(
  query: string = QUERY,
  limit: number = LIMIT,
): Promise<string> {
  const results = await runDdgr(query, limit, { safesearch: "moderate" });

  // An empty result set is a soft failure everywhere else in the
  // pipeline: ddgr exits 0, formatWebsearchResult renders a tidy "no
  // results" line, freeze and vhs happily render it, and every
  // mechanical check in regen.sh passes. The only symptom is a preview
  // asset advertising a search tool that finds nothing. Nearly always
  // it's DuckDuckGo rate-limiting a burst of regens, not a real
  // zero-hit query — so fail here and let the human retry later.
  if (results.length === 0) {
    throw new Error(
      `ddgr returned no results for "${query}". DuckDuckGo rate-limits bursts of ` +
        "queries; wait a few minutes and re-run rather than committing an empty preview.",
    );
  }

  return formatWebsearchResult(
    {
      details: { query, results },
      expanded: true,
      isError: false,
      expandHint: "press e to expand",
    },
    theme,
  );
}
