// No-op `Theme` stub for unit tests of the pure formatters used by tool
// renderers. Real `Theme` from @mariozechner/pi-coding-agent applies ANSI
// escape codes; for snapshot-style assertions on formatter output we want
// the strings to come through verbatim so tests stay readable and don't
// depend on the active theme.
//
// Typed as `Pick<Theme, "fg" | "bold">` so the stub stays in lockstep
// with the real Theme surface the formatters touch — including the
// `ThemeColor` union for `fg`'s color param. Centralizing the cast here
// keeps `as unknown as Theme` out of every test file.

import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";

export function stubTheme(): Pick<Theme, "fg" | "bold"> {
  return {
    fg(_color: ThemeColor, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  };
}
