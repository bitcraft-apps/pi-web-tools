import { describe, it, expect } from "vitest";
import { commandExists } from "../src/lib/which.js";

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
