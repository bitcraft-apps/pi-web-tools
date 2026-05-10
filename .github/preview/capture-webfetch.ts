// Regenerates .github/preview/webfetch-output.ans from a live
// fetchAsMarkdown call against a stable Wikipedia URL.
// See .github/preview/README.md for usage.
//
// Run with: npx -y tsx .github/preview/capture-webfetch.ts
// (plain `node` won't strip the .ts imports below.)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import { fetchAsMarkdown, formatWebfetchResult } from "../../src/webfetch.ts";

// Stable, on-brand, visually varied (heading + prose + numbered list +
// links). See spec §"Decisions" #1 for why this URL.
const URL = "https://en.wikipedia.org/wiki/Unix_philosophy";

// freeze.json renders at 1280×720 with 18px JetBrains Mono, line_height
// 1.3, 40px top/bottom padding. That fits ~27 visible lines. Slice
// slightly under that so the bottom isn't visually clipped mid-line.
// If you bump freeze.json's height, bump this in lockstep.
const MAX_LINES = 25;

// Same SGR pattern as capture-websearch.ts. Two compile-time guarantees:
//   1. SGR_FG keys must be valid ThemeColor names.
//   2. theme.fg() throws at runtime if the formatter reaches for a role
//      not in the map — drift fails loudly instead of silently emitting
//      uncolored text.
//
// formatWebfetchResult uses: error, success, muted. If a future change
// to that formatter adds a new role, the throw below catches it on the
// next regen.
const SGR_FG: Partial<Record<ThemeColor, string>> = {
  success: "\x1b[38;5;42m", // green, ✓ header
  muted: "\x1b[38;5;245m", // gray, footer / dim text
  error: "\x1b[38;5;203m", // red, error path (unused on success path)
};

const SGR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
} as const;

const theme = {
  fg(role: ThemeColor, text: string) {
    const code = SGR_FG[role];
    if (code === undefined) {
      throw new Error(
        `capture-webfetch.ts theme: unknown role "${role}". Add it to SGR_FG or update the formatter.`,
      );
    }
    return `${code}${text}${SGR.reset}`;
  },
  bold(text: string) {
    return `${SGR.bold}${text}${SGR.reset}`;
  },
};

// Live fetch. Throws non-zero with stack trace via tsx if the URL
// 404s, gets blocked, or pandoc/w3m aren't on PATH.
const body = await fetchAsMarkdown({ url: URL });

const rendered = formatWebfetchResult(
  {
    details: {
      url: URL,
      chars: body.length,
      bytes: Buffer.byteLength(body, "utf-8"),
    },
    body,
    expanded: true,
    isError: false,
    expandHint: "press e to expand",
  },
  theme,
);

// Slice to MAX_LINES so the on-disk fixture matches what the rendered
// PNG actually shows. Without this, freeze would clip silently and the
// .ans file would mislead reviewers about what's in the picture.
const lines = rendered.split("\n");
const truncated = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join("\n") : rendered;

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "webfetch-output.ans");
// Normalize to exactly one trailing newline. The truncated path's
// `slice().join("\n")` can already end in `\n` when the 25th slice
// element is the empty tail from rendered's terminating newline; the
// non-truncated path's `rendered` always ends in `\n`. Without this
// guard the old code appended a second `\n` and the fixture drifted
// on every regen.
const final = truncated.endsWith("\n") ? truncated : truncated + "\n";
writeFileSync(out, final, "utf8");
console.log(
  `wrote ${out} (${truncated.length} chars, ${Math.min(lines.length, MAX_LINES)} lines)`,
);
