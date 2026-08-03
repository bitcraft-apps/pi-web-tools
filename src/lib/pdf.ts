import { commandExists, probeOnce } from "./which.ts";
import { runCommand } from "./run-command.ts";

// pdftotext on a moderately-sized PDF (academic paper, RFC) finishes in tens
// of ms; on a 5 MB scanned/OCR-heavy PDF it can legitimately spike to several
// seconds on slower machines. 25s is the catastrophe backstop, kept under
// webfetch's 30s outer budget so a timeout here surfaces as our specific
// "pdftotext timed out" warning rather than the generic outer abort.
const PDFTOTEXT_TIMEOUT_MS = 25_000;

let warnedNoPdftotext = false;
let warnedPdftotextFailure = false;

export const detectPdftotext = probeOnce(() => commandExists("pdftotext"));

/** Test-only: clear the cached detection and the one-shot warning latches. */
export function __resetPdftotextCache(): void {
  detectPdftotext.reset();
  warnedNoPdftotext = false;
  warnedPdftotextFailure = false;
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
    // `-layout`: preserve physical layout of the page. For prose this is
    //   marginally worse than the default reading-order mode (extra
    //   whitespace), but for the things people actually feed webfetch PDFs to
    //   read — papers with two-column layouts, datasheets, tables in RFCs —
    //   `-layout` is the difference between readable text and a
    //   column-interleaved word salad.
    // `-enc UTF-8`: pdftotext's default is the platform locale; force UTF-8 so
    //   downstream consumers don't get cp1252 or whatever LANG=C decides.
    // `- -`: stdin → stdout. No temp files.
    return await runCommand("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], {
      stdin: new Uint8Array(buf),
      timeoutMs: PDFTOTEXT_TIMEOUT_MS,
    });
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
