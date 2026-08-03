import { describe, it, expect } from "vitest";
import { commandExists, probeOnce } from "../src/lib/which.js";

describe("commandExists", () => {
  it("resolves true for a command guaranteed to be on PATH (node)", async () => {
    expect(await commandExists("node")).toBe(true);
  });

  it("resolves false for a command that does not exist", async () => {
    expect(await commandExists("definitely-not-a-cmd-xyz")).toBe(false);
  });

  it("does not interpret shell metacharacters in the command name", async () => {
    // If `cmd` were interpolated into the shell script, this would run
    // `command -v node` and resolve true. Passed as a positional arg, it's
    // looked up literally as a (nonexistent) binary named `node; echo hi`.
    expect(await commandExists("node; echo hi")).toBe(false);
  });
});

describe("probeOnce", () => {
  it("runs the underlying probe only once across repeated calls", async () => {
    let calls = 0;
    const probe = probeOnce(async () => ++calls);
    expect(await probe()).toBe(1);
    expect(await probe()).toBe(1);
    expect(calls).toBe(1);
  });

  it("caches negative results too", async () => {
    let calls = 0;
    const probe = probeOnce(async () => {
      calls++;
      return null;
    });
    expect(await probe()).toBeNull();
    expect(await probe()).toBeNull();
    expect(calls).toBe(1);
  });

  it("shares one probe between callers that race before it resolves", async () => {
    let calls = 0;
    const probe = probeOnce(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return "done";
    });
    const [a, b] = await Promise.all([probe(), probe()]);
    expect([a, b]).toEqual(["done", "done"]);
    expect(calls).toBe(1);
  });

  it("re-probes exactly once after reset()", async () => {
    let calls = 0;
    const probe = probeOnce(async () => ++calls);
    await probe();
    probe.reset();
    expect(await probe()).toBe(2);
    expect(await probe()).toBe(2);
    expect(calls).toBe(2);
  });
});
