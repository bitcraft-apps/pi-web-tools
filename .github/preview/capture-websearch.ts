// Regenerates .github/preview/websearch-output.ans from a live ddgr query.
// See .github/preview/README.md for usage.
//
// Run with: npx -y tsx .github/preview/capture-websearch.ts
// (plain `node` won't strip the .ts imports below.)
//
// The rendering itself lives in render-websearch.ts, shared with
// demo-cli.ts. This file is only the persist half.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderWebsearch } from "./render-websearch.js";

// Top-level await; any throw exits non-zero with a stack trace via tsx.
const rendered = await renderWebsearch();

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "websearch-output.ans");
writeFileSync(out, rendered + "\n", "utf8");
console.log(`wrote ${out} (${rendered.length} chars)`);
