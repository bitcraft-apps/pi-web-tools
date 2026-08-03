import { expect, it } from "vitest";
import { PANDOC_ARGS } from "../../src/lib/html2md.js";
import { runCommand } from "../../src/lib/run-command.js";
import { CONTRACT_TIMEOUT_MS, CONVERTER_HTML, LONG_SENTENCE } from "./_fixtures.js";
import { contract } from "./_gate.js";

// Runs the real pandoc with PANDOC_ARGS — the same array htmlToMarkdown() uses.
// test/html2md.test.ts asserts the argv literals; this file asserts pandoc still
// accepts them and still emits markdown we can hand to a model.

contract("pandoc", () => {
  it("turns HTML into markdown, keeps links, and does not wrap", async () => {
    const md = await runCommand("pandoc", PANDOC_ARGS, {
      stdin: CONVERTER_HTML,
      timeoutMs: CONTRACT_TIMEOUT_MS,
    });

    // `-t markdown_strict`: the heading is a markdown heading, not HTML.
    // Either style counts. pandoc emits ATX (`# x`) since 2.11.2 and setext
    // (`x` over `===`) before that; both are markdown, and production does not
    // care which.
    expect(md).toMatch(/(^#+ Contract Heading$)|(^Contract Heading\n=+$)/m);
    expect(md).toContain("[link](https://example.com/link)");

    // `-f html`: the input was parsed as HTML, not passed through as text.
    expect(md).not.toContain("<h1");

    // `--wrap=none`: a 157-character sentence stays on one line. Wrapped output
    // costs tokens and breaks nothing else, so this flag is easy to lose.
    expect(md.split("\n")).toContain(LONG_SENTENCE);
  });
});
