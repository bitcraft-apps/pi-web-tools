import { spawn } from "node:child_process";
import { commandExists } from "./which.ts";

const CONVERT_TIMEOUT_MS = 10_000;

// 50 MB peak-memory backstop on converter stdout, matching extract.ts and
// pdf.ts. Pandoc/w3m emit markdown/text smaller than their HTML input on every
// realistic page; this only fires on a runaway converter. Combined with
// CONVERT_TIMEOUT_MS it keeps a misbehaving converter from doubling peak heap
// (the input HTML is already in memory in the caller).
const CONVERT_MAX_BYTES = 50 * 1024 * 1024;

export type Converter = "pandoc" | "w3m";

let cachedDetection: Promise<Converter | null> | undefined;

export async function detectConverter(): Promise<Converter | null> {
  if (cachedDetection !== undefined) return cachedDetection;
  cachedDetection = (async () => {
    if (await commandExists("pandoc")) return "pandoc";
    if (await commandExists("w3m")) return "w3m";
    return null;
  })();
  return cachedDetection;
}

/** Test-only: clear the cached converter detection. */
export function __resetConverterCache(): void {
  cachedDetection = undefined;
}

function runConverter(cmd: string, args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return reject(e);
    }
    // Collect Buffers and decode once at close: per-chunk toString("utf-8")
    // mojibakes when a multi-byte codepoint straddles a chunk boundary.
    // No setEncoding() on stdout/stderr, so chunks are always Buffers.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let overflowed = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, CONVERT_TIMEOUT_MS);

    child.stdout.on("data", (c: Buffer) => {
      // Once we've decided to abort (overflow or timeout), drop further chunks
      // on the floor — otherwise the converter can keep firing data events
      // between SIGTERM and close, repeatedly clearing chunks and re-calling
      // kill. Harmless but wasteful.
      if (overflowed || timedOut) return;
      stdoutBytes += c.length;
      if (stdoutBytes > CONVERT_MAX_BYTES) {
        overflowed = true;
        // Drop already-buffered chunks immediately so a misbehaving converter
        // in a long-lived agent process doesn't keep ~50 MB live until the
        // close handler runs and the Promise rejects.
        stdoutChunks.length = 0;
        child.kill("SIGTERM");
        return;
      }
      stdoutChunks.push(c);
    });
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Overflow is checked first: the overflow kill also yields a non-zero
      // (or null) exit code, and the cap message is the useful one.
      if (overflowed) return reject(new Error(`${cmd} stdout exceeded ${CONVERT_MAX_BYTES} bytes`));
      if (timedOut) return reject(new Error(`${cmd} timed out`));
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        return reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
      }
      resolve(Buffer.concat(stdoutChunks).toString("utf-8"));
    });

    // Swallow EPIPE/ECONNRESET on stdin: the converter may exit before
    // consuming the full input (timeout, overflow kill, crash, or a parse
    // bailout). Without this handler node treats the writable's "error" as
    // unhandled and crashes the process. The close/error/timeout paths above
    // already produce the right Promise outcome.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
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
  const raw =
    converter === "pandoc"
      ? await runConverter("pandoc", ["-f", "html", "-t", "markdown_strict", "--wrap=none"], html)
      : await runConverter("w3m", ["-dump", "-T", "text/html", "-cols", "120"], html);
  return stripBase64DataUris(raw);
}
