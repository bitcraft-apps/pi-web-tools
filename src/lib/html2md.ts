import { commandExists, probeOnce } from "./which.ts";
import { runCommand } from "./run-command.ts";

const CONVERT_TIMEOUT_MS = 10_000;

export type Converter = "pandoc" | "w3m";

export const detectConverter = probeOnce(async (): Promise<Converter | null> => {
  if (await commandExists("pandoc")) return "pandoc";
  if (await commandExists("w3m")) return "w3m";
  return null;
});

/** Test-only: clear the cached converter detection. */
export function __resetConverterCache(): void {
  detectConverter.reset();
}

// Match base64-encoded `data:` URIs, capturing the MIME type and any
// parameters between it and the `;base64,` marker (e.g. `;charset=utf-8`).
// Stops at the first character that can't appear in base64 padding-aware
// alphabet, which neatly terminates inside `![](...)`, `<a href="...">`,
// and bare-URL contexts without dragging in surrounding markdown.
//
// Notes on the character classes:
//   - Subtype is `+` (not `*`): both type and subtype are required per
//     RFC 2045, so `data:image/;base64,...` is malformed and we don't
//     want to elide it (better to leave obviously-broken input visible).
//   - Parameter values are unquoted only. RFC 2045 permits quoted-string
//     values (`;name="foo bar"`) but pandoc/w3m have never been observed
//     to emit them inside data: URIs in practice; revisit if seen.
//   - Base64 alphabet is the standard RFC 4648 set (`+/=`); URL-safe
//     `-_` is intentionally omitted because RFC 2397 mandates standard
//     alphabet for `data:` URIs. Don't "fix" this.
//
// Plain (non-base64) `data:` URIs are intentionally left alone — they're
// short and can carry actual readable content (`data:text/plain,Hello`).
// The win is entirely on the base64 path; see issue #127.
const DATA_URI_BASE64 =
  /data:([a-z][a-z0-9+\-.]*\/[a-z0-9+\-.]+(?:;[a-zA-Z0-9_+\-.=]+)*);base64,[A-Za-z0-9+/=]+/gi;

/**
 * Replace the body of every base64 `data:` URI in `md` with `…`, keeping
 * the MIME tag (and any parameters like `;charset=utf-8`) so a text-only
 * consumer can still tell *what kind* of inline blob was elided.
 *
 * Pandoc faithfully passes `<img src="data:image/svg+xml;base64,...">`
 * through to `![](data:...)`; on chrome-heavy modern sites this routinely
 * consumes >99% of `max_chars` with payload no LLM or human can decode.
 * See issue #127 for the budget-waste table that motivated this.
 *
 * Exported for unit tests; all production callers go through
 * `htmlToMarkdown`, which applies it unconditionally to every output.
 */
export function stripBase64DataUris(md: string): string {
  return md.replace(DATA_URI_BASE64, (_m, mimeWithParams: string) => {
    return `data:${mimeWithParams};base64,…`;
  });
}

export async function htmlToMarkdown(html: string): Promise<string> {
  const converter = await detectConverter();
  if (!converter) {
    throw new Error("Need pandoc or w3m installed. brew install pandoc");
  }
  // One regex pass over the converter output strips base64 `data:` URI
  // payloads. Done here (post-converter) rather than pre-HTML so it covers
  // both pandoc and w3m output, and any future renderer, without per-
  // converter wiring. The cost is a single linear-time regex over a string
  // we already hold; see issue #127.
  const args =
    converter === "pandoc"
      ? ["-f", "html", "-t", "markdown_strict", "--wrap=none"]
      : ["-dump", "-T", "text/html", "-cols", "120"];
  const raw = await runCommand(converter, args, {
    stdin: html,
    timeoutMs: CONVERT_TIMEOUT_MS,
  });
  return stripBase64DataUris(raw);
}
