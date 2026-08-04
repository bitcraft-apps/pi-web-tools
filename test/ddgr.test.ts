import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
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
    expect(out[0]!.snippet).toHaveLength(240);
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
    expect(parseOutput(stdout, 8)[0]!.snippet).toBe("");
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

  it("drops region codes that don't match the ll-cc shape", () => {
    // The backstop behind websearch's `pattern` (#248), for the callers that
    // bound never reaches: direct importers of this function, and providers
    // that constrain sampling only on a best-effort basis. Dropping (not
    // throwing) matches the documented "unknown codes fall back to ddgr's
    // default" behavior, and keeps flag-shaped strings from reaching argv as
    // a --reg value.
    for (const region of ["US-EN", "pl_pl", "pl", "polish", "--proxy=x", "pl-pl extra"]) {
      expect(buildDdgrArgs("q", 8, { region })).not.toContain("--reg");
    }
    expect(buildDdgrArgs("q", 8, { region: "pl-pl" })).toContain("--reg");
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

  it("omits --time when not provided", () => {
    expect(buildDdgrArgs("q", 8)).not.toContain("--time");
    expect(buildDdgrArgs("q", 8, { region: "us-en" })).not.toContain("--time");
  });

  it("includes --time <bucket> for each valid value", () => {
    for (const t of ["d", "w", "m", "y"] as const) {
      const args = buildDdgrArgs("q", 8, { time: t });
      expect(args).toContain("--time");
      expect(args[args.indexOf("--time") + 1]).toBe(t);
    }
  });

  it("--time stays before -- so it isn't parsed as part of the query", () => {
    const args = buildDdgrArgs("q", 8, { time: "w" });
    expect(args.indexOf("--time")).toBeLessThan(args.indexOf("--"));
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

  it("maps a timeout to the rate-limit message, not the generic one", async () => {
    // ddgr is the only call site that overrides runCommand's default
    // `${cmd} timed out` text, so pin the override here.
    vi.doMock("node:child_process", () => ({
      spawn: () => {
        // Child that never closes on its own — only kill() (from the timeout
        // branch) makes it close.
        const ee: any = new EventEmitter();
        ee.stdout = new Readable({ read() {} });
        ee.stderr = new Readable({ read() {} });
        ee.kill = () => {
          ee.stdout.push(null);
          ee.stderr.push(null);
          setImmediate(() => ee.emit("close", null));
        };
        return ee;
      },
    }));
    const { runDdgr } = await import("../src/lib/ddgr.js");
    vi.useFakeTimers();
    try {
      const p = runDdgr("test", 8);
      const assertion = expect(p).rejects.toThrow(/DuckDuckGo timed out/);
      await vi.advanceTimersByTimeAsync(16_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
