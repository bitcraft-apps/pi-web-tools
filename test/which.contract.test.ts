import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { commandExists } from "../src/lib/which.js";

// Locks in the no-interpolation contract of commandExists() at the spawn-call
// level. The behavior-level test in which.test.ts also passes when `sh` is
// missing entirely (both branches resolve `false`), so it can't distinguish
// "shell rejected the lookup" from "we accidentally interpolated cmd into the
// script body". This file does — it asserts the exact argv shape.

function fakeChild(exitCode: number) {
  const ee: any = new EventEmitter();
  setImmediate(() => ee.emit("close", exitCode));
  return ee;
}

beforeEach(() => {
  vi.mocked(spawn).mockReset();
});

describe("commandExists() spawn contract", () => {
  it("invokes sh -c with cmd as a positional arg ($1), never interpolated", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeChild(1));
    await commandExists("node; echo hi");

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(spawn).mock.calls[0]!;
    const [bin, args, opts] = call;
    expect(bin).toBe("sh");
    // Shape: ["-c", <script that uses "$1">, "_" ($0), <cmd> ($1)]. The script
    // body must NOT contain the cmd; the cmd must arrive as the 4th element.
    // Asserting the full tuple (rather than positional indices behind a cast)
    // means a refactor that changes argv shape will fail this test loudly
    // instead of silently passing.
    expect(args).toEqual(["-c", 'command -v "$1" >/dev/null 2>&1', "_", "node; echo hi"]);
    expect(opts).toMatchObject({ stdio: ["ignore", "ignore", "ignore"] });
  });
});
