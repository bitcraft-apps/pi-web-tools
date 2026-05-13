import { spawn } from "node:child_process";

const CONVERT_TIMEOUT_MS = 10_000;

async function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("which", [cmd], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve(false);
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

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
    const stdoutChunks: (Buffer | string)[] = [];
    const stderrChunks: (Buffer | string)[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, CONVERT_TIMEOUT_MS);

    child.stdout.on("data", (c: Buffer | string) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer | string) => stderrChunks.push(c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${cmd} timed out`));
      if (code !== 0) {
        const stderr = stderrChunks
          .map((c) => (Buffer.isBuffer(c) ? c.toString("utf-8") : c))
          .join("");
        return reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
      }
      resolve(stdoutChunks.map((c) => (Buffer.isBuffer(c) ? c.toString("utf-8") : c)).join(""));
    });

    child.stdin.end(stdin);
  });
}

// Match base64-encoded `data:` URIs, capturing the MIME type and any
// parameters between it and the `;base64,` marker (e.g. `;charset=utf-8`).
// Stops at the first character that can't appear in base64 padding-aware
// alphabet, which neatly terminates inside `![](...)`, `<a href="...">`,
// and bare-URL contexts without dragging in surrounding markdown.
//
// Plain (non-base64) `data:` URIs are intentionally left alone — they're
// short and can carry actual readable content (`data:text/plain,Hello`).
// The win is entirely on the base64 path; see issue #127.
const DATA_URI_BASE64 =
  /data:([a-z][a-z0-9+\-.]*\/[a-z0-9+\-.]*(?:;[a-zA-Z0-9_+\-.=]+)*);base64,[A-Za-z0-9+/=]+/gi;

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
