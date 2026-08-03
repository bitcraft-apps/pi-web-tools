import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

// Gate for the contract suite. Every file under test/contract/ runs a REAL
// external binary with the exact argv the production code builds. Nothing here
// mocks node:child_process — that is the point. The rest of the suite proves the
// argv we build; these files prove the argv is accepted and the output still has
// the shape we parse.
//
// Two environment flags control the suite:
//
//   PI_CONTRACT_STRICT=1   A missing binary is a failure, not a skip. The
//                          contract CI job sets this. Without it a skip can
//                          hide a break: the job stays green and every user
//                          breaks.
//   PI_CONTRACT_NETWORK=1  Run the cases that need live network. Only the one
//                          ddgr query needs it (issue #216). Off by default, so
//                          `bun run test` stays offline and deterministic.
//
// If you add a flag, make a test read it. Issue #219 removed a flag that no
// test read, which is worse than no flag at all.
const STRICT = process.env.PI_CONTRACT_STRICT === "1";

/** True when the cases that need live network must run. */
export const NETWORK = process.env.PI_CONTRACT_NETWORK === "1";

/**
 * Check whether `cmd` is on $PATH.
 *
 * Same lookup as `commandExists()` in src/lib/which.ts, but synchronous,
 * because `describe()` gates are decided when vitest collects the file.
 */
export function hasBinary(cmd: string): boolean {
  const r = spawnSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "_", cmd], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return r.status === 0;
}

/**
 * Register a contract block for `binary`.
 *
 * - Binary present: the block runs.
 * - Binary absent, normal run: the block is skipped, so a contributor without
 *   the tools still gets a green local run.
 * - Binary absent, `PI_CONTRACT_STRICT=1`: the block is replaced by one test
 *   that fails, so the strict CI job cannot pass on skips.
 */
export function contract(binary: string, fn: () => void): void {
  const title = `${binary} contract`;
  if (hasBinary(binary)) {
    describe(title, fn);
    return;
  }
  if (STRICT) {
    describe(title, () => {
      it(`${binary} is on $PATH`, () => {
        expect.unreachable(
          `${binary} is not installed. PI_CONTRACT_STRICT=1 does not permit a skip here: ` +
            `install ${binary} or fix the workflow step that installs it.`,
        );
      });
    });
    return;
  }
  describe.skip(title, fn);
}
