import { spawn } from "node:child_process";
import { commandExists } from "./which.ts";

// pdftotext on a moderately-sized PDF (academic paper, RFC) finishes in tens
// of ms; on a 5 MB scanned/OCR-heavy PDF it can legitimately spike to several
// seconds on slower machines. 25s is the catastrophe backstop, kept under
// webfetch's 30s outer budget so a timeout here surfaces as our specific
// "pdftotext timed out" warning rather than the generic outer abort.
const PDFTOTEXT_TIMEOUT_MS = 25_000;

// 50 MB peak-memory backstop on pdftotext stdout, matching extract.ts. The
// upstream byte cap on the PDF itself is MAX_RESPONSE_BYTES (5 MB) — a 5 MB
// PDF that yields >50 MB of plain text is pathological (mostly OCR'd page
// duplication) and will be killed here. Combined with PDFTOTEXT_TIMEOUT_MS
// this prevents a misbehaving extractor from doubling peak heap.
const PDFTOTEXT_MAX_BYTES = 50 * 1024 * 1024;

// Cached for the life of the process. A `null` result (no pdftotext on
// $PATH) also sticks: pdftotext installed mid-process won't be picked up
// until restart. Acceptable for an agent process; do not "fix" by re-probing.
let cachedDetection: Promise<boolean> | undefined;
let warnedNoPdftotext = false;
let warnedPdftotextFailure = false;

export async function detectPdftotext(): Promise<boolean> {
  if (cachedDetection !== undefined) return cachedDetection;
  cachedDetection = commandExists("pdftotext");
  return cachedDetection;
}

/** Test-only: clear the cached detection and the one-shot warning latches. */
export function __resetPdftotextCache(): void {
  cachedDetection = undefined;
  warnedNoPdftotext = false;
  warnedPdftotextFailure = false;
}

function runPdftotext(stdin: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // `-layout`: preserve physical layout of the page. For prose this is
      //   marginally worse than the default reading-order mode (extra
      //   whitespace), but for the things people actually feed webfetch
      //   PDFs to read — papers with two-column layouts, datasheets,
      //   tables in RFCs — `-layout` is the difference between readable
      //   text and a column-interleaved word salad.
      // `-enc UTF-8`: pdftotext's default is the platform locale; force
      //   UTF-8 so downstream consumers don't get cp1252 or whatever
      //   LANG=C decides.
      // `- -`: stdin → stdout. No temp files.
      child = spawn("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return reject(e);
    }
    // Same buffering pattern as extract.ts: collect Buffers and decode once
    // at close. Per-chunk toString("utf-8") would mojibake on multi-byte
    // codepoints straddling a chunk boundary.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let overflowed = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, PDFTOTEXT_TIMEOUT_MS);

    child.stdout.on("data", (c: Buffer) => {
      // Once we've decided to abort (overflow or timeout), drop further
      // chunks on the floor — otherwise pdftotext can keep firing data
      // events between SIGTERM and close, repeatedly clearing chunks and
      // re-calling kill. Harmless but wasteful.
      if (overflowed || timedOut) return;
      stdoutBytes += c.length;
      if (stdoutBytes > PDFTOTEXT_MAX_BYTES) {
        overflowed = true;
        // Drop already-buffered chunks immediately so a misbehaving
        // pdftotext in a long-lived agent process doesn't keep ~50 MB live
        // until the close handler runs and the Promise rejects.
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
      if (overflowed)
        return reject(new Error(`pdftotext stdout exceeded ${PDFTOTEXT_MAX_BYTES} bytes`));
      if (timedOut) return reject(new Error("pdftotext timed out"));
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        return reject(new Error(`pdftotext exited with code ${code}: ${stderr}`));
      }
      resolve(Buffer.concat(stdoutChunks).toString("utf-8"));
    });

    // Swallow EPIPE/ECONNRESET on stdin: pdftotext may exit before consuming
    // the full input (timeout, overflow kill, crash, malformed-PDF early
    // bailout). Without this handler node treats the writable's "error" as
    // unhandled and crashes the process. The close/error/timeout paths
    // above already produce the right Promise outcome.
    child.stdin.on("error", () => {});
    // Node's writable.end() accepts a Uint8Array directly — no Buffer wrapper
    // needed (Buffer is a Uint8Array subclass, not a required input type).
    child.stdin.end(stdin);
  });
}

/**
 * Convert a PDF byte buffer to plain text using `pdftotext` (poppler).
 * Returns the extracted text on success, or `null` if `pdftotext` is not
 * available on `$PATH`, the binary failed, or it timed out.
 *
 * Caller is responsible for choosing what to do on `null` — webfetch.ts
 * preserves the historical "Cannot fetch application/pdf" error so users
 * who haven't installed poppler see no behavior regression.
 *
 * Output is plain text — no markdown wrapping, no fences. PDFs aren't
 * structured for markdown rendering; pretending they are produces worse
 * output than `pdftotext -layout`.
 */
export async function pdfToText(buf: ArrayBuffer): Promise<string | null> {
  const have = await detectPdftotext();
  if (!have) {
    if (!warnedNoPdftotext) {
      warnedNoPdftotext = true;
      // One-shot stderr warning. Visible to humans running pi locally;
      // never injected into tool output (would be prompt-token noise per
      // call). Mirrors extract.ts's no-extractor warning.
      console.warn(
        "[pi-web-tools/webfetch] No `pdftotext` on $PATH. " +
          "Fetches of application/pdf will be rejected with the existing 'Cannot fetch' error. " +
          "Install poppler to enable PDF→text: " +
          "`brew install poppler` (macOS) or `apt install poppler-utils` (Debian/Ubuntu).",
      );
    }
    return null;
  }
  try {
    return await runPdftotext(new Uint8Array(buf));
  } catch (err) {
    if (!warnedPdftotextFailure) {
      warnedPdftotextFailure = true;
      // One-shot stderr warning so a permanently-broken pdftotext (bad
      // install, version skew) doesn't silently degrade every PDF fetch.
      // Mirrors the no-pdftotext warning above; never injected into tool
      // output.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[pi-web-tools/webfetch] pdftotext failed; falling back to "Cannot fetch" error. ` +
          `Subsequent failures are silent. First error: ${msg}`,
      );
    }
    return null;
  }
}
