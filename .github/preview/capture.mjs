#!/usr/bin/env node
// Regenerates .github/preview/websearch-output.ans from a live ddgr query.
// See .github/preview/README.md for usage.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runDdgr } from "../../src/lib/ddgr.ts";
import { formatWebsearchResult } from "../../src/websearch.ts";

const QUERY = "pi coding agent";
const LIMIT = 5;

// Minimal ANSI theme. `freeze` reads ANSI SGR codes and turns them
// into colored spans in the rendered PNG.
const SGR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  fg: {
    accent: "\x1b[38;5;39m", // bright cyan-blue, links/titles
    dim: "\x1b[38;5;245m", // gray, urls
    success: "\x1b[38;5;42m", // green, ✓ header
    warning: "\x1b[38;5;214m",
    error: "\x1b[38;5;203m",
  },
};

const theme = {
  fg(role, text) {
    const code = SGR.fg[role] ?? "";
    return `${code}${text}${SGR.reset}`;
  },
  bold(text) {
    return `${SGR.bold}${text}${SGR.reset}`;
  },
};

const results = await runDdgr(QUERY, LIMIT, { safesearch: "moderate" });

const rendered = formatWebsearchResult(
  {
    details: { query: QUERY, results },
    expanded: true,
    isError: false,
    expandHint: "press e to expand",
  },
  theme,
);

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "websearch-output.ans");
writeFileSync(out, rendered + "\n", "utf8");
console.error(`wrote ${out} (${rendered.length} chars)`);
