import { expect, it } from "vitest";
import { PDFTOTEXT_ARGS } from "../../src/lib/pdf.js";
import { runCommand } from "../../src/lib/run-command.js";
import { CONTRACT_TIMEOUT_MS, onePagePdf, PDF_TEXT_DECODED, PDF_TEXT_SOURCE } from "./_fixtures.js";
import { contract } from "./_gate.js";

// Runs the real pdftotext with PDFTOTEXT_ARGS — the same array pdfToText() uses.
// This is also the only place binary stdin is exercised end to end: pdfToText()
// hands a Uint8Array to runCommand(), and a text-mode regression there would
// corrupt every PDF fetch.

contract("pdftotext", () => {
  it("reads a PDF from stdin and writes UTF-8 text to stdout", async () => {
    const text = await runCommand("pdftotext", PDFTOTEXT_ARGS, {
      stdin: onePagePdf(PDF_TEXT_SOURCE),
      timeoutMs: CONTRACT_TIMEOUT_MS,
    });

    // `- -`: stdin to stdout, no temp files. Plus `-enc UTF-8`: the WinAnsi
    // bytes \351 and \357 come back as é and ï. Under the platform default
    // (or `-enc ASCII7`) they degrade to "cafe naive" and this fails.
    expect(text).toContain(PDF_TEXT_DECODED);

    // Not asserted: `-layout`. It only changes output on multi-column pages,
    // and building a two-column PDF by hand to prove one flag is a worse trade
    // than leaving the flag to the unit test in test/pdf.test.ts.
  });
});
