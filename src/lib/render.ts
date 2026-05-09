import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

/**
 * Minimal slice of the pi-coding-agent `Theme` that the pure formatters
 * touch. `Pick<Theme, ...>` (rather than a hand-rolled interface) keeps
 * `fg`'s color param typed as the real `ThemeColor` union — typos like
 * `theme.fg("accnet", ...)` are caught at compile time instead of
 * silently producing the wrong output. Type-only import → zero runtime
 * cost.
 */
export type FormatterTheme = Pick<Theme, "fg" | "bold">;

/**
 * Reuses the previously-mounted Text component when possible, otherwise
 * mints a fresh one. The (0, 0) padding mirrors the convention from
 * pi-coding-agent's built-in `read`/`write` tool renderers — tool rows
 * sit flush in the chat container, the host adds outer padding.
 *
 * The `instanceof` guard matters because pi-tui is a peer dep: even
 * pinned to a single major, a consumer hoisting differently (or mixing
 * in a transitive dep on a different range) can end up with two
 * physical copies of pi-tui in node_modules.
 * `context.lastComponent` may be a `Text` from the *other* copy —
 * different class identity, different prototype. Without the guard,
 * `.setText()` would either crash or write to a stale instance the host
 * then discards. With the guard, we degrade to "always new Text" — the
 * renderer keeps working, only the per-redraw reuse optimization is
 * lost.
 */
export function ensureText(lastComponent: unknown): Text {
  return lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
}
