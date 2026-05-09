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
// Roles must cover every theme.fg(role, …) call reachable from the
// formatters this script invokes. Today that's formatWebsearchResult,
// which only touches accent/dim/success/warning/error. If a new
// formatter is wired in below and it reaches for a role missing from
// SGR.fg, the fg() wrapper throws — drift fails loudly instead of
// degrading the fixture.
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
} as const;

const theme = {
  // `role: ThemeColor` (not `string`) keeps this signature in sync with
  // the real Theme contract, so a typo in src/websearch.ts like
  // `theme.fg("dimm", …)` fails at tsc instead of at capture time.
  fg(role: ThemeColor, text: string) {
    const code = (SGR.fg as Partial<Record<ThemeColor, string>>)[role];
    if (code === undefined) {
      throw new Error(
        `capture.ts theme: unknown role "${role}". Add it to SGR.fg or update the formatter.`,
      );
    }
    return `${code}${text}${SGR.reset}`;
  },
  bold(text: string) {
    return `${SGR.bold}${text}${SGR.reset}`;
  },
};

let results;
try {
  results = await runDdgr(QUERY, LIMIT, { safesearch: "moderate" });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(
    `capture.ts: runDdgr failed: ${msg}\n` +
      `Make sure ddgr is on PATH (brew install ddgr / pipx install ddgr).`,
  );
  process.exit(1);
}

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
