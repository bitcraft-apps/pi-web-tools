// Shared ANSI theme for the preview capture scripts and the VHS demo
// runner. `freeze` and `vhs` both read ANSI SGR codes and turn them into
// colored spans, so the fixtures/recordings need a Theme-shaped object
// that emits raw escapes instead of pi's TUI colors.
//
// Callers keep their own SGR_FG map rather than sharing one union map.
// That is deliberate: the throw in makeTheme() is a drift detector, and
// it only detects drift if each map is scoped to exactly the roles its
// formatter reaches today. A shared union map would silently absorb a
// formatter that starts using a new role.

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export const SGR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
} as const;

/**
 * Build a minimal `{ fg, bold }` theme over an SGR foreground map.
 *
 * `fgMap` is declaratively typed `Partial<Record<ThemeColor, string>>`
 * (no cast). That gives two compile-time guarantees at every call site:
 *   1. Keys must be valid ThemeColor names — typos like `dimm:` fail
 *      tsc, not at capture time.
 *   2. Indexing returns `string | undefined`, which keeps the runtime
 *      guard below honest.
 *
 * `label` is used in the error message so a drift failure names the file
 * that needs updating.
 */
export function makeTheme(label: string, fgMap: Partial<Record<ThemeColor, string>>) {
  return {
    fg(role: ThemeColor, text: string) {
      const code = fgMap[role];
      if (code === undefined) {
        throw new Error(
          `${label} theme: unknown role "${role}". Add it to SGR_FG or update the formatter.`,
        );
      }
      return `${code}${text}${SGR.reset}`;
    },
    bold(text: string) {
      return `${SGR.bold}${text}${SGR.reset}`;
    },
  };
}
