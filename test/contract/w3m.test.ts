import { expect, it } from "vitest";
import { W3M_ARGS } from "../../src/lib/html2md.js";
import { runCommand } from "../../src/lib/run-command.js";
import { CONTRACT_TIMEOUT_MS, CONVERTER_HTML, LONG_SENTENCE } from "./_fixtures.js";
import { contract } from "./_gate.js";

// w3m is the fallback converter, used when pandoc is absent. The test drives
// W3M_ARGS directly instead of calling htmlToMarkdown(), because detectConverter()
// prefers pandoc — going through the production entry point would leave this
// branch unexercised on any machine that has both.

contract("w3m", () => {
  it("renders HTML as plain text inside the column budget", async () => {
    const text = await runCommand("w3m", W3M_ARGS, {
      stdin: CONVERTER_HTML,
      timeoutMs: CONTRACT_TIMEOUT_MS,
    });

    expect(text).toContain("Contract Heading");
    expect(text).toContain("Body text with a");

    // `-T text/html`: stdin was rendered as HTML. Without it w3m treats the
    // input as plain text and echoes the tags.
    expect(text).not.toContain("<h1");

    // `-cols 120`: the long sentence is broken, and no line exceeds the budget.
    const lines = text.split("\n");
    expect(lines).not.toContain(LONG_SENTENCE);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(120);
  });
});
