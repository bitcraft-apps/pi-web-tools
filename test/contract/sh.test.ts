import { expect, it } from "vitest";
import { commandExists } from "../../src/lib/which.js";
import { contract } from "./_gate.js";

// Closes the hole named in test/which.contract.test.ts's own header: the
// behaviour test in test/which.test.ts "also passes when `sh` is missing
// entirely (both branches resolve `false`)". Every binary probe in this package
// goes through commandExists(), so if `sh -c 'command -v ...'` ever stops
// working, pandoc, w3m, trafilatura, rdrview and pdftotext all read as absent
// and every fetch degrades. Nothing else proves the positive case with a real
// subprocess.

contract("sh", () => {
  it("resolves an installed command", async () => {
    expect(await commandExists("sh")).toBe(true);
  });

  it("rejects a command that is not installed", async () => {
    expect(await commandExists("pi-web-tools-no-such-binary")).toBe(false);
  });
});
