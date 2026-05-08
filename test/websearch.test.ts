import { describe, it, expect, vi } from "vitest";

vi.mock("../src/lib/ddgr.js", () => ({
  runDdgr: vi.fn(),
}));

import { websearchTool } from "../src/websearch.js";
import { runDdgr } from "../src/lib/ddgr.js";

describe("websearchTool", () => {
  it("has correct shape", () => {
    expect(websearchTool.name).toBe("websearch");
    expect(websearchTool.description).toMatch(/duckduckgo/i);
    expect(typeof websearchTool.execute).toBe("function");
  });

  it("returns JSON content with results from ddgr", async () => {
    (runDdgr as any).mockResolvedValueOnce([
      { title: "Example", url: "https://example.com", snippet: "snip" },
    ]);
    const result = await websearchTool.execute(
      "tc1",
      { query: "test", limit: 8 },
      new AbortController().signal,
      () => {},
      {} as any,
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    const textContent = result.content[0]! as any;
    const parsed = JSON.parse(textContent.text);
    expect(parsed.query).toBe("test");
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].url).toBe("https://example.com");
  });

  it("default limit is 8 when not provided", async () => {
    (runDdgr as any).mockResolvedValueOnce([]);
    await websearchTool.execute(
      "tc2",
      { query: "x" },
      new AbortController().signal,
      () => {},
      {} as any,
    );
    expect(runDdgr).toHaveBeenLastCalledWith(
      "x",
      8,
      expect.objectContaining({ safesearch: "moderate" }),
    );
  });

  it("clamps limit to max 25", async () => {
    (runDdgr as any).mockResolvedValueOnce([]);
    await websearchTool.execute(
      "tc3",
      { query: "x", limit: 100 },
      new AbortController().signal,
      () => {},
      {} as any,
    );
    expect(runDdgr).toHaveBeenLastCalledWith(
      "x",
      25,
      expect.objectContaining({ safesearch: "moderate" }),
    );
  });

  it("passes region through to runDdgr", async () => {
    (runDdgr as any).mockResolvedValueOnce([]);
    await websearchTool.execute(
      "tc-reg",
      { query: "pierogi", region: "pl-pl" },
      new AbortController().signal,
      () => {},
      {} as any,
    );
    expect(runDdgr).toHaveBeenLastCalledWith("pierogi", 8, {
      region: "pl-pl",
      safesearch: "moderate",
    });
  });

  it("passes safesearch through to runDdgr", async () => {
    (runDdgr as any).mockResolvedValueOnce([]);
    await websearchTool.execute(
      "tc-ss",
      { query: "x", safesearch: "off" },
      new AbortController().signal,
      () => {},
      {} as any,
    );
    expect(runDdgr).toHaveBeenLastCalledWith(
      "x",
      8,
      expect.objectContaining({ safesearch: "off" }),
    );
  });

  it("propagates errors from ddgr", async () => {
    (runDdgr as any).mockRejectedValueOnce(new Error("ddgr not installed. Run: brew install ddgr"));
    await expect(
      websearchTool.execute(
        "tc4",
        { query: "x" },
        new AbortController().signal,
        () => {},
        {} as any,
      ),
    ).rejects.toThrow(/ddgr not installed/);
  });

  it("empty results return empty array, not error", async () => {
    (runDdgr as any).mockResolvedValueOnce([]);
    const result = await websearchTool.execute(
      "tc5",
      { query: "x" },
      new AbortController().signal,
      () => {},
      {} as any,
    );
    expect(result.content).toHaveLength(1);
    const textContent = result.content[0]! as any;
    const parsed = JSON.parse(textContent.text);
    expect(parsed.results).toEqual([]);
  });
});
