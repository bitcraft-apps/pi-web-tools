import { expect, it } from "vitest";
import { TRAFILATURA_ARGS } from "../../src/lib/extract.js";
import { runCommand } from "../../src/lib/run-command.js";
import { ARTICLE_HTML, ARTICLE_SENTENCE, CONTRACT_TIMEOUT_MS } from "./_fixtures.js";
import { contract } from "./_gate.js";

// Runs the real trafilatura with TRAFILATURA_ARGS — the same array
// extractContent() uses. The pipeline keeps the extractor output only when it is
// at least 1% of the input (src/lib/pipeline.ts), so an extractor that starts
// emitting nothing degrades silently. This test is the alarm.

contract("trafilatura", () => {
  it("keeps the article body, drops page chrome, and emits HTML", async () => {
    const out = await runCommand("trafilatura", TRAFILATURA_ARGS, {
      stdin: ARTICLE_HTML,
      timeoutMs: CONTRACT_TIMEOUT_MS,
    });

    expect(out).toContain(ARTICLE_SENTENCE);

    // The reason the extractor exists: navigation and footers are gone.
    expect(out).not.toContain("NAVCHROME");
    expect(out).not.toContain("FOOTERCHROME");

    // `--html`: output is cleaned HTML, so the pandoc/w3m step downstream gets
    // one canonical markdown style on both the extractor-on and -off paths.
    // Without the flag trafilatura emits plain text and this fails.
    expect(out).toMatch(/<p>/);

    // Not asserted: `--no-comments`. Measured on trafilatura 2.0.0, the flag has
    // no observable effect under `--html`: that mode emits the main body only, so
    // a comment section is already absent with or without it. The flag does work
    // in plain-text mode, which this package never uses. An assertion here would
    // therefore pass whether or not we still pass the flag.
  });
});
