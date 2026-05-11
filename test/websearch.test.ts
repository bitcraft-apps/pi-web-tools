import { describe, it, expect, vi } from "vitest";
import { stubExtensionContext } from "./_helpers/context.js";

vi.mock("../src/lib/ddgr.js", () => ({
  runDdgr: vi.fn(),
}));

import { websearchTool } from "../src/websearch.js";
import { runDdgr } from "../src/lib/ddgr.js";

// Module-scoped on purpose: the Proxy is stateless (every property read
// throws), so sharing it across tests is safe and avoids per-test
// allocation. If a future test needs to mutate per-case expectations,
// inline `stubExtensionContext()` at that call site instead of mutating
// this shared instance.
const stubCtx = stubExtensionContext();

function textOf(content: { type: string; text?: string }[]): string {
  const first = content[0]!;
  if (first.type !== "text" || typeof first.text !== "string") {
    throw new Error(`expected text content, got ${first.type}`);
  }
  return first.text;
}

describe("websearchTool", () => {
  it("has correct shape", () => {
    expect(websearchTool.name).toBe("websearch");
    expect(websearchTool.description).toMatch(/duckduckgo/i);
    expect(typeof websearchTool.execute).toBe("function");
  });

  it("returns JSON content with results from ddgr", async () => {
    vi.mocked(runDdgr).mockResolvedValueOnce([
      { title: "Example", url: "https://example.com", snippet: "snip" },
    ]);
    const result = await websearchTool.execute(
      "tc1",
      { query: "test", limit: 8 },
      new AbortController().signal,
      () => {},
      stubCtx,
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    const parsed = JSON.parse(textOf(result.content));
    expect(parsed.query).toBe("test");
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].url).toBe("https://example.com");
  });

  it("default limit is 8 when not provided", async () => {
    vi.mocked(runDdgr).mockResolvedValueOnce([]);
    await websearchTool.execute(
      "tc2",
      { query: "x" },
      new AbortController().signal,
      () => {},
      stubCtx,
    );
    expect(runDdgr).toHaveBeenLastCalledWith(
      "x",
      8,
      expect.objectContaining({ safesearch: "moderate" }),
    );
  });

  it("clamps limit to max 25", async () => {
    vi.mocked(runDdgr).mockResolvedValueOnce([]);
    await websearchTool.execute(
      "tc3",
      { query: "x", limit: 100 },
      new AbortController().signal,
      () => {},
      stubCtx,
    );
    expect(runDdgr).toHaveBeenLastCalledWith(
      "x",
      25,
      expect.objectContaining({ safesearch: "moderate" }),
    );
  });

  it("passes region through to runDdgr", async () => {
    vi.mocked(runDdgr).mockResolvedValueOnce([]);
    await websearchTool.execute(
      "tc-reg",
      { query: "pierogi", region: "pl-pl" },
      new AbortController().signal,
      () => {},
      stubCtx,
    );
    expect(runDdgr).toHaveBeenLastCalledWith("pierogi", 8, {
      region: "pl-pl",
      safesearch: "moderate",
    });
  });

  it("passes safesearch through to runDdgr", async () => {
    vi.mocked(runDdgr).mockResolvedValueOnce([]);
    await websearchTool.execute(
      "tc-ss",
      { query: "x", safesearch: "off" },
      new AbortController().signal,
      () => {},
      stubCtx,
    );
    expect(runDdgr).toHaveBeenLastCalledWith(
      "x",
      8,
      expect.objectContaining({ safesearch: "off" }),
    );
  });

  it("passes time through to runDdgr", async () => {
    vi.mocked(runDdgr).mockResolvedValueOnce([]);
    await websearchTool.execute(
      "tc-time",
      { query: "latest pi release", time: "w" },
      new AbortController().signal,
      () => {},
      stubCtx,
    );
    expect(runDdgr).toHaveBeenLastCalledWith(
      "latest pi release",
      8,
      expect.objectContaining({ time: "w" }),
    );
  });

  it("omits time from runDdgr opts when not supplied", async () => {
    vi.mocked(runDdgr).mockResolvedValueOnce([]);
    await websearchTool.execute(
      "tc-no-time",
      { query: "x" },
      new AbortController().signal,
      () => {},
      stubCtx,
    );
    const opts = vi.mocked(runDdgr).mock.lastCall?.[2];
    expect(opts?.time).toBeUndefined();
  });

  it("propagates errors from ddgr", async () => {
    vi.mocked(runDdgr).mockRejectedValueOnce(
      new Error("ddgr not installed. Run: brew install ddgr"),
    );
    await expect(
      websearchTool.execute("tc4", { query: "x" }, new AbortController().signal, () => {}, stubCtx),
    ).rejects.toThrow(/ddgr not installed/);
  });

  it("empty results return empty array, not error", async () => {
    vi.mocked(runDdgr).mockResolvedValueOnce([]);
    const result = await websearchTool.execute(
      "tc5",
      { query: "x" },
      new AbortController().signal,
      () => {},
      stubCtx,
    );
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(textOf(result.content));
    expect(parsed.results).toEqual([]);
  });
});
