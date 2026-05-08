// No-op `Theme` stub for unit tests of the pure formatters used by tool
// renderers. Real `Theme` from @mariozechner/pi-coding-agent applies ANSI
// escape codes; for snapshot-style assertions on formatter output we want
// the strings to come through verbatim so tests stay readable and don't
// depend on the active theme.
//
// `theme.fg(color, text) -> text` and `theme.bold(text) -> text` is the
// minimum surface the formatters touch. Centralizing the assertion here
// keeps `as unknown as Theme` casts out of every test file.

import type { ThemeLike } from "../../src/websearch.js";

export function stubTheme(): ThemeLike {
  return {
    fg(_color, text) {
      return text;
    },
    bold(text) {
      return text;
    },
  };
}
