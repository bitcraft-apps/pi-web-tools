import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseOutput, runDdgr, type DdgrResult } from "../src/lib/ddgr.js";

describe("parseOutput", () => {
  it("parses ddgr JSON array into results", () => {
    const stdout = JSON.stringify([
      { title: "First", url: "https://a.example", abstract: "Some text" },
      { title: "Second", url: "https://b.example", abstract: "More" },
    ]);
    const out = parseOutput(stdout, 8);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: "First", url: "https://a.example", snippet: "Some text" });
  });

  it("truncates snippet to 240 chars", () => {
    const long = "x".repeat(500);
    const stdout = JSON.stringify([{ title: "T", url: "https://e.example", abstract: long }]);
    const out = parseOutput(stdout, 8);
    expect(out[0].snippet).toHaveLength(240);
  });

  it("returns empty array for empty stdout", () => {
    expect(parseOutput("[]", 8)).toEqual([]);
  });

  it("respects limit", () => {
    const stdout = JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({ title: `T${i}`, url: `https://e${i}.com`, abstract: "" }))
    );
    expect(parseOutput(stdout, 3)).toHaveLength(3);
  });

  it("missing abstract becomes empty snippet", () => {
    const stdout = JSON.stringify([{ title: "T", url: "https://e.example" }]);
    expect(parseOutput(stdout, 8)[0].snippet).toBe("");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseOutput("not json", 8)).toThrow(/parse/i);
  });
});

describe("runDdgr (mocked)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("throws if ddgr not on PATH", async () => {
    vi.doMock("node:child_process", () => ({
      spawn: () => {
        const err: any = new Error("spawn ddgr ENOENT");
        err.code = "ENOENT";
        throw err;
      },
    }));
    const { runDdgr } = await import("../src/lib/ddgr.js");
    await expect(runDdgr("test", 8)).rejects.toThrow(/ddgr not installed/i);
  });
});
