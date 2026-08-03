import { expect, it } from "vitest";
import { rdrviewArgs } from "../../src/lib/extract.js";
import { runCommand } from "../../src/lib/run-command.js";
import { ARTICLE_HTML, ARTICLE_SENTENCE, ARTICLE_URL, CONTRACT_TIMEOUT_MS } from "./_fixtures.js";
import { contract } from "./_gate.js";

// rdrview is the fallback extractor, used when trafilatura is absent. Driven
// through rdrviewArgs() rather than extractContent() for the same reason as
// w3m: detectExtractor() prefers trafilatura, so the production entry point
// never reaches this branch on a machine that has both.
//
// rdrviewArgs() also decides the macOS `--disable-sandbox` flag, so running it
// here proves the flag is accepted on the platform the test runs on.

contract("rdrview", () => {
  it("keeps the article body, drops page chrome, and resolves relative links", async () => {
    const out = await runCommand("rdrview", rdrviewArgs(ARTICLE_URL), {
      stdin: ARTICLE_HTML,
      timeoutMs: CONTRACT_TIMEOUT_MS,
    });

    // `-H`: cleaned HTML on stdout, article body kept.
    expect(out).toContain(ARTICLE_SENTENCE);
    expect(out).toMatch(/<p/);

    expect(out).not.toContain("NAVCHROME");
    expect(out).not.toContain("FOOTERCHROME");

    // `-u`: the base URL resolves `/relative/page` to an absolute link. This is
    // the one thing rdrview does that trafilatura cannot.
    expect(out).toContain("https://example.com/relative/page");
  });
});
