// Renders real `webfetch` output to an ANSI string.
//
// Split from capture-webfetch.ts for the same reason as
// render-websearch.ts: the PNG (freeze) and the MP4 (vhs) must show the
// same thing, which only holds if the URL, line budget, and theme live
// in exactly one place.

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { fetchAsMarkdown } from "../../src/lib/pipeline.ts";
import { formatWebfetchResult } from "../../src/webfetch.ts";
import { makeTheme } from "./ansi-theme.ts";

// Stable, on-brand, visually varied (heading + prose + numbered list +
// links). See spec §"Decisions" #1 for why this URL.
export const URL = "https://en.wikipedia.org/wiki/Unix_philosophy";

// freeze.json renders at 1280×720 with 18px JetBrains Mono, line_height
// 1.3, 40px top/bottom padding. That fits ~27 visible lines. Slice
// slightly under that so the bottom isn't visually clipped mid-line.
// If you bump freeze.json's height, bump this in lockstep.
//
// This budget governs the PNG only. demo.tape shares the frame geometry
// but spends rows on the prompt and the typed command, leaving ~21 —
// so 25 never binds there and this slice is not what keeps the video
// from scrolling. `--max-chars 900` in the tape is. Don't read this
// constant as covering the video; re-measure per the row-count snippet
// in this directory's README when the tape's content changes.
export const MAX_LINES = 25;

// Roles must cover every theme.fg(role, …) call reachable from
// formatWebfetchResult — today: error, success, muted. If a future
// change to that formatter adds a role, makeTheme's guard throws on the
// next regen.
const SGR_FG: Partial<Record<ThemeColor, string>> = {
  success: "\x1b[38;5;42m", // green, ✓ header
  muted: "\x1b[38;5;245m", // gray, footer / dim text
  error: "\x1b[38;5;203m", // red, error path (unused on success path)
};

const theme = makeTheme("render-webfetch.ts", SGR_FG);

/**
 * Live fetch + render, sliced to MAX_LINES.
 *
 * Throws (non-zero via tsx) if the URL 404s, gets blocked, or
 * pandoc/w3m aren't on PATH.
 *
 * `url` and `maxChars` are parameters, not hard-coded constants,
 * because demo.tape types them on screen and must actually fetch what
 * it typed — the video passes a smaller `--max-chars` so the body fits
 * the frame without scrolling. They default to URL / the tool's own
 * default so capture-webfetch.ts keeps producing exactly the fixture
 * the PNG was rendered from.
 *
 * The slice is applied here rather than by the caller so the on-disk
 * fixture matches what the rendered frame actually shows. Without it,
 * freeze would clip silently and the .ans file would mislead reviewers
 * about what's in the picture.
 *
 * Returns text with exactly one trailing newline. Both paths need
 * normalizing: the truncated path's `slice().join("\n")` can already end
 * in `\n` when the 25th element is the empty tail from `rendered`'s
 * terminating newline, while `rendered` itself always ends in one.
 * Without this the fixture drifted by a newline on every regen.
 */
export async function renderWebfetch(
  url: string = URL,
  maxChars?: number,
): Promise<{ text: string; lines: number }> {
  const body = await fetchAsMarkdown({ url, max_chars: maxChars });

  const rendered = formatWebfetchResult(
    {
      details: {
        url,
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

  const lines = rendered.split("\n");
  const truncated = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join("\n") : rendered;

  return {
    text: truncated.endsWith("\n") ? truncated : truncated + "\n",
    lines: Math.min(lines.length, MAX_LINES),
  };
}
