import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommandRaw } from "../../src/lib/run-command.js";
import { CONTRACT_TIMEOUT_MS } from "./_fixtures.js";
import { contract } from "./_gate.js";

// Covers the three defensive paths of src/lib/run-command.ts against a real
// subprocess: the timeout SIGTERM, the stdout byte cap, and the stdin EPIPE
// swallow. Every other test of these paths (test/extract.test.ts,
// test/pdf.test.ts, test/html2md.test.ts, test/ddgr.test.ts) drives a fake
// EventEmitter child, which resolves whatever the test tells it to — it cannot
// show that a process is actually reaped, that the cap fires against a real
// firehose, or that a real EPIPE is swallowed rather than crashing the worker.
// A kill() that stopped terminating the child would leave every timed-out
// webfetch leaking a process, and nothing today would notice (issue #236).
//
// Gated on `sh`, already a proven contract dependency (see sh.test.ts). `sleep`
// rides along ungated: it is a POSIX utility present wherever `sh` is, and a
// second gate would only add a way for the strict job to fail on a non-problem.
//
// The wrapper does not expose the child's pid, so the child reports its own:
// each script starts with `echo $$ > "$1"`, passed positionally, never
// interpolated into the script body (same shape as _gate.ts). The rejection
// alone is not proof of death — the pid is what gets asserted on.

/**
 * Scratch directory for the pid files, created per run inside the block below
 * so a skipped run leaves nothing behind.
 */
let dir: string;

/**
 * Turn a rejection into a resolved value, attaching the handler synchronously.
 *
 * Load-bearing: both failing paths can settle within a millisecond or two —
 * before the pid poll below returns — and a `rejects` matcher applied after that
 * point attaches its handler too late. Node then reports an unhandled rejection
 * and vitest fails the file even though every assertion holds.
 */
function settle<T>(p: Promise<T>): Promise<T | Error> {
  return p.catch((e: Error) => e);
}

/** Poll `f` until it holds a pid, or fail. The child writes it immediately. */
async function readPidWhenWritten(f: string): Promise<number> {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      const pid = Number.parseInt(readFileSync(f, "utf-8").trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // Not written yet.
    }
    if (Date.now() > deadline) expect.unreachable(`child never wrote its pid to ${f}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Assert `pid` is gone. Node has already reaped it by the time close fires. */
async function expectDead(pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      // Signal 0 checks for existence without delivering anything.
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) {
      expect.unreachable(
        `pid ${pid} is still alive after runCommandRaw rejected — SIGTERM did not land, ` +
          `so the promise settled while the child kept running and holding its pipe`,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

contract("sh", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-run-command-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("kills the child when timeoutMs expires, and rejects with timeoutMessage", async () => {
    const pidFile = join(dir, "timeout.pid");
    // `exec` matters: it makes the pid in the file the pid of the long-lived
    // process, so this cannot pass while an orphaned grandchild survives.
    // 250ms rather than tens of ms so the child reliably wins the race to write
    // its pid file on a loaded runner — still sub-second, and no 30s wait.
    const run = settle(
      runCommandRaw("sh", ["-c", 'echo $$ > "$1"; exec sleep 30', "_", pidFile], {
        timeoutMs: 250,
        timeoutMessage: "run-command contract: timed out on purpose",
      }),
    );
    const pid = await readPidWhenWritten(pidFile);

    const outcome = await run;
    if (!(outcome instanceof Error)) expect.unreachable("the child outlived its timeout");
    // The exact message, not the `${cmd} timed out` default: every call site
    // passes its own, and that string is what reaches the user.
    expect(outcome.message).toBe("run-command contract: timed out on purpose");
    await expectDead(pid);
  });

  it("kills the child when stdout exceeds maxBytes", async () => {
    const pidFile = join(dir, "cap.pid");
    // Shell builtins only — no dependency on `yes`. A ~1 KB line trips a 4096
    // byte cap in a handful of iterations.
    const run = settle(
      runCommandRaw(
        "sh",
        ["-c", 'echo $$ > "$1"; while :; do echo "$2"; done', "_", pidFile, "x".repeat(1024)],
        // Generous timeout so a rejection can only have come from the cap.
        { timeoutMs: CONTRACT_TIMEOUT_MS, maxBytes: 4096 },
      ),
    );
    const pid = await readPidWhenWritten(pidFile);

    const outcome = await run;
    if (!(outcome instanceof Error)) expect.unreachable("the child's output was never capped");
    // No assertion on byte counts: the cap is a backstop, not a budget.
    expect(outcome.message).toMatch(/stdout exceeded/);
    await expectDead(pid);
  });

  it("resolves when the child exits without reading stdin", async () => {
    // 1 MiB exceeds any pipe buffer (64 KiB), so the write cannot finish before
    // `exit 0` — a real EPIPE lands on child.stdin. Measured with the handler in
    // runCommandRaw removed: the write raises an uncaught `write EPIPE`, vitest
    // reports it against this file and the run exits non-zero. In production that
    // same error crashes the agent process, which is what the handler prevents.
    const result = await runCommandRaw("sh", ["-c", "exit 0"], {
      stdin: "x".repeat(1024 * 1024),
      timeoutMs: CONTRACT_TIMEOUT_MS,
    });

    expect(result.code).toBe(0);
  });
});
