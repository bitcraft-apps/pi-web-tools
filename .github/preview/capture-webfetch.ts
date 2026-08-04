// Regenerates .github/preview/webfetch-output.ans from a live
// fetchAsMarkdown call against a stable Wikipedia URL.
// See .github/preview/README.md for usage.
//
// Run with: npx -y tsx .github/preview/capture-webfetch.ts
// (plain `node` won't strip the .ts imports below.)
//
// The rendering — including the MAX_LINES slice and trailing-newline
// normalization — lives in render-webfetch.ts, shared with demo-cli.ts.
// This file is only the persist half.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MAX_LINES, renderWebfetch } from "./render-webfetch.js";

// Top-level await; any throw exits non-zero with a stack trace via tsx.
const { text, lines } = await renderWebfetch();

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "webfetch-output.ans");
writeFileSync(out, text, "utf8");
console.log(`wrote ${out} (${text.length} chars, ${lines}/${MAX_LINES} lines)`);
