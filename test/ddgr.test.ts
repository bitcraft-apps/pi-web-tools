import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseOutput, buildDdgrArgs } from "../src/lib/ddgr.js";

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
      Array.from({ length: 10 }, (_, i) => ({
        title: `T${i}`,
        url: `https://e${i}.com`,
        abstract: "",
      })),
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

describe("buildDdgrArgs", () => {
  it("builds default args without region or unsafe", () => {
    const args = buildDdgrArgs("hello", 8);
    expect(args).toEqual(["--json", "--num", "8", "--noprompt", "--", "hello"]);
    expect(args).not.toContain("--reg");
    expect(args).not.toContain("--unsafe");
  });

  it("omits --reg when region is empty or whitespace", () => {
    expect(buildDdgrArgs("q", 8, { region: "" })).not.toContain("--reg");
    expect(buildDdgrArgs("q", 8, { region: "   " })).not.toContain("--reg");
  });

  it("trims surrounding whitespace from region", () => {
    const args = buildDdgrArgs("q", 8, { region: "  pl-pl  " });
    expect(args[args.indexOf("--reg") + 1]).toBe("pl-pl");
  });

  it("includes --reg when region provided", () => {
    const args = buildDdgrArgs("hello", 5, { region: "pl-pl" });
    expect(args).toContain("--reg");
    expect(args[args.indexOf("--reg") + 1]).toBe("pl-pl");
  });

  it("adds --unsafe only when safesearch is off", () => {
    expect(buildDdgrArgs("q", 8, { safesearch: "off" })).toContain("--unsafe");
    expect(buildDdgrArgs("q", 8, { safesearch: "moderate" })).not.toContain("--unsafe");
    expect(buildDdgrArgs("q", 8, { safesearch: "strict" })).not.toContain("--unsafe");
    expect(buildDdgrArgs("q", 8)).not.toContain("--unsafe");
  });

  it("keeps query last after -- separator", () => {
    const args = buildDdgrArgs("--evil", 8, { region: "us-en", safesearch: "off" });
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("--evil");
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
