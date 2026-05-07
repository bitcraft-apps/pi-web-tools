import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

function fakeChild(stdoutText: string, exitCode = 0, stderrText = "") {
  const ee: any = new EventEmitter();
  ee.stdout = Readable.from([stdoutText]);
  ee.stderr = Readable.from([stderrText]);
  ee.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  ee.kill = () => {};
  setImmediate(() => ee.emit("close", exitCode));
  return ee;
}

import {
  detectExtractor,
  extractContent,
  __resetExtractorCache,
} from "../src/lib/extract.js";

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  (spawn as any).mockReset();
  __resetExtractorCache();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("detectExtractor", () => {
  it("prefers trafilatura when both are present", async () => {
    (spawn as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" && args[0] === "trafilatura") return fakeChild("/usr/bin/trafilatura\n", 0);
      if (cmd === "which" && args[0] === "rdrview") return fakeChild("/usr/bin/rdrview\n", 0);
      return fakeChild("", 1);
    });
    expect(await detectExtractor()).toBe("trafilatura");
    // rdrview should not have been probed (short-circuit on first hit)
    const whichCalls = (spawn as any).mock.calls.filter((c: any[]) => c[0] === "which");
    expect(whichCalls.map((c: any[]) => c[1][0])).toEqual(["trafilatura"]);
  });

  it("falls back to rdrview when trafilatura is missing", async () => {
    (spawn as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" && args[0] === "trafilatura") return fakeChild("", 1);
      if (cmd === "which" && args[0] === "rdrview") return fakeChild("/usr/bin/rdrview\n", 0);
      return fakeChild("", 1);
    });
    expect(await detectExtractor()).toBe("rdrview");
  });

  it("returns null when neither is installed", async () => {
    (spawn as any).mockImplementation(() => fakeChild("", 1));
    expect(await detectExtractor()).toBeNull();
  });

  it("memoizes detection across calls (which probed at most once per binary)", async () => {
    (spawn as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" && args[0] === "trafilatura") return fakeChild("/usr/bin/trafilatura\n", 0);
      return fakeChild("", 1);
    });
    await detectExtractor();
    await detectExtractor();
    await detectExtractor();
    const whichCalls = (spawn as any).mock.calls.filter((c: any[]) => c[0] === "which");
    expect(whichCalls).toHaveLength(1);
  });

  it("single-flights concurrent first calls", async () => {
    (spawn as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" && args[0] === "trafilatura") return fakeChild("/usr/bin/trafilatura\n", 0);
      return fakeChild("", 1);
    });
    await Promise.all([detectExtractor(), detectExtractor(), detectExtractor()]);
    const whichCalls = (spawn as any).mock.calls.filter((c: any[]) => c[0] === "which");
    expect(whichCalls).toHaveLength(1);
  });
});

describe("extractContent", () => {
  it("invokes trafilatura with --html --no-comments --precision and returns its stdout", async () => {
    (spawn as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" && args[0] === "trafilatura") return fakeChild("/x\n", 0);
      if (cmd === "trafilatura") return fakeChild("<article>clean</article>", 0);
      return fakeChild("", 1);
    });
    const out = await extractContent("<html>...</html>", "https://example.com/a");
    expect(out).toBe("<article>clean</article>");
    const trafCall = (spawn as any).mock.calls.find((c: any[]) => c[0] === "trafilatura");
    expect(trafCall).toBeTruthy();
    expect(trafCall[1]).toEqual(["--html", "--no-comments", "--precision"]);
  });

  it("invokes rdrview with -H -u <url> and platform-conditional --disable-sandbox", async () => {
    (spawn as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" && args[0] === "trafilatura") return fakeChild("", 1);
      if (cmd === "which" && args[0] === "rdrview") return fakeChild("/x\n", 0);
      if (cmd === "rdrview") return fakeChild("<article>r</article>", 0);
      return fakeChild("", 1);
    });
    const out = await extractContent("<html>x</html>", "https://example.com/a");
    expect(out).toBe("<article>r</article>");
    const rdrCall = (spawn as any).mock.calls.find((c: any[]) => c[0] === "rdrview");
    expect(rdrCall).toBeTruthy();
    expect(rdrCall[1].slice(0, 3)).toEqual(["-H", "-u", "https://example.com/a"]);
    if (process.platform === "darwin") {
      expect(rdrCall[1]).toContain("--disable-sandbox");
    } else {
      expect(rdrCall[1]).not.toContain("--disable-sandbox");
    }
  });

  it("returns null (does not throw) when extractor exits non-zero", async () => {
    (spawn as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" && args[0] === "trafilatura") return fakeChild("/x\n", 0);
      if (cmd === "trafilatura") return fakeChild("", 2, "boom");
      return fakeChild("", 1);
    });
    expect(await extractContent("<html>x</html>", "https://example.com")).toBeNull();
  });

  it("returns null and emits a one-shot stderr warning when no extractor present", async () => {
    (spawn as any).mockImplementation(() => fakeChild("", 1));
    expect(await extractContent("<html>x</html>", "https://example.com")).toBeNull();
    expect(await extractContent("<html>y</html>", "https://example.com")).toBeNull();
    expect(await extractContent("<html>z</html>", "https://example.com")).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/pipx install trafilatura/);
  });

  it("does not warn when an extractor is present", async () => {
    (spawn as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" && args[0] === "trafilatura") return fakeChild("/x\n", 0);
      if (cmd === "trafilatura") return fakeChild("<p>ok</p>", 0);
      return fakeChild("", 1);
    });
    await extractContent("<html>x</html>", "https://example.com");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
