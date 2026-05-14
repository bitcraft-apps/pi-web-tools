import { describe, it, expect } from "vitest";
import { commandExists } from "../src/lib/which.js";

describe("commandExists", () => {
  it("resolves true for a command guaranteed to be on PATH (node)", async () => {
    expect(await commandExists("node")).toBe(true);
  });

  it("resolves false for a command that does not exist", async () => {
    expect(await commandExists("definitely-not-a-cmd-xyz")).toBe(false);
  });
});
