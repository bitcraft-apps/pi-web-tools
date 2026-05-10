// Regenerates .github/preview/websearch-output.ans from a live ddgr query.
// See .github/preview/README.md for usage.
//
// Run with: npx -y tsx .github/preview/capture.ts
// (plain `node` won't strip the .ts imports below.)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import { runDdgr } from "../../src/lib/ddgr.ts";
import { formatWebsearchResult } from "../../src/websearch.ts";

const QUERY = "pi coding agent";
const LIMIT = 5;

// Minimal ANSI theme. `freeze` reads ANSI SGR codes and turns them
// into colored spans in the rendered PNG.
//
// `SGR.fg` is declaratively typed `Partial<Record<ThemeColor, string>>`
// (no cast). That gives two compile-time guarantees inside this file:
//   1. SGR.fg keys must be valid ThemeColor names — typos like
//      `dimm:` fail tsc here, not at capture time.
//   2. Indexing `SGR.fg[role]` returns `string | undefined`, forcing
//      the runtime `code === undefined` guard below to stay honest.
// (Typos in src/* are caught by src/*'s own tsc against the real
// Theme contract; that's not this file's job.)
const SGR_FG: Partial<Record<ThemeColor, string>> = {
  accent: "\x1b[38;5;39m", // bright cyan-blue, links/titles
  dim: "\x1b[38;5;245m", // gray, urls
  success: "\x1b[38;5;42m", // green, ✓ header
  warning: "\x1b[38;5;214m",
  error: "\x1b[38;5;203m",
};

const SGR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
} as const;

// Roles must cover every theme.fg(role, …) call reachable from the
// formatters this script invokes. Today that's formatWebsearchResult,
// which only touches accent/dim/success/warning/error. If a new
// formatter is wired in below and it reaches for a role missing from
// SGR_FG, the fg() wrapper throws — drift fails loudly instead of
// degrading the fixture.
const theme = {
  fg(role: ThemeColor, text: string) {
    const code = SGR_FG[role];
    if (code === undefined) {
      throw new Error(
        `capture.ts theme: unknown role "${role}". Add it to SGR_FG or update the formatter.`,
      );
    }
    return `${code}${text}${SGR.reset}`;
  },
  bold(text: string) {
    return `${SGR.bold}${text}${SGR.reset}`;
  },
};

// Top-level await; any throw exits non-zero with a stack trace via tsx.
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
console.log(`wrote ${out} (${rendered.length} chars)`);
