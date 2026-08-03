import { expect, it } from "vitest";
import { buildDdgrArgs, runDdgr } from "../../src/lib/ddgr.js";
import { runCommandRaw } from "../../src/lib/run-command.js";
import { CONTRACT_TIMEOUT_MS } from "./_fixtures.js";
import { contract, NETWORK } from "./_gate.js";

// Two cases, because ddgr is the one binary whose useful output needs the
// network:
//
//   1. Offline: every long flag buildDdgrArgs() can emit is still in `--help`.
//      Catches a rename or removal on any machine, in any CI job, for free.
//   2. Live query, gated on PI_CONTRACT_NETWORK=1. The only test in the repo
//      that reads the flag. It is the only way to prove ddgr still puts the
//      snippet in a field named `abstract`, which parseOutput() reads.
//
// The flag list is derived from buildDdgrArgs() rather than written out here, so
// a flag added there is checked without touching this file.
const LONG_FLAGS = buildDdgrArgs("contract probe", 3, {
  region: "us-en",
  safesearch: "off",
  time: "d",
}).filter((a) => a.startsWith("--") && a !== "--");

contract("ddgr", () => {
  it("still documents every flag we pass", async () => {
    // `--help` is split across stdout and stderr (ddgr 2.2 prints the omniprompt
    // key list on stderr), so both are searched. Exit code is not checked, for
    // the same reason runDdgr() uses runCommandRaw: ddgr's exit codes are not a
    // reliable signal.
    const { stdout, stderr } = await runCommandRaw("ddgr", ["--help"], {
      timeoutMs: CONTRACT_TIMEOUT_MS,
    });
    const help = stdout + stderr;

    expect(LONG_FLAGS.length).toBeGreaterThan(0);
    for (const flag of LONG_FLAGS) {
      expect(help, `ddgr --help no longer mentions ${flag}`).toContain(flag);
    }
  });

  // 25s: runDdgr's own timeout is 15s, and a rate-limited DuckDuckGo will use
  // all of it before the specific "likely rate-limited" error surfaces.
  it.skipIf(!NETWORK)(
    "returns JSON results carrying title, url, and abstract",
    async () => {
      const results = await runDdgr("duckduckgo", 3, { region: "us-en" });

      // parseOutput() maps ddgr's `abstract` field to `snippet`. A rename
      // upstream leaves every snippet empty, and nothing else would notice.
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.title).not.toBe("");
        expect(r.url).toMatch(/^https?:\/\//);
      }
      expect(results.some((r) => r.snippet !== "")).toBe(true);
    },
    25_000,
  );
});
