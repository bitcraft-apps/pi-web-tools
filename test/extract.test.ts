import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

function fakeChild(stdoutText: string, exitCode = 0, stderrText = "") {
  const ee: any = new EventEmitter();
  // Readable.from([string]) yields strings; the implementation now expects
  // Buffers (matches real `spawn` behavior with no setEncoding call).
  ee.stdout = Readable.from([Buffer.from(stdoutText, "utf-8")]);
  ee.stderr = Readable.from([Buffer.from(stderrText, "utf-8")]);
  ee.stdin = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  ee.kill = () => {};
  // Emit "close" *after* stdout drains, so the implementation's data handlers
  // have populated stdoutChunks before close fires. Without this we relied on
  // process.nextTick (Readable.from) beating setImmediate (close), which is
  // an implementation detail of node's scheduling. resume() forces flow even
  // when the consumer (e.g. commandExists) doesn't attach a data listener —
  // mirrors real `spawn`, where the OS pipe closes regardless of consumption.
  ee.stdout.on("end", () => ee.emit("close", exitCode));
  setImmediate(() => ee.stdout.resume());
  return ee;
}

/**
 * Child that emits "close" *before* anyone calls stdin.end(), then has its
 * stdin synchronously emit an EPIPE-class error on write. Models a real
 * extractor that crashes / is killed by SIGTERM mid-input. Without an
 * stdin.on("error") handler in the implementation, this would crash the
 * process via unhandled "error" on a Writable.
 */
function fakeChildEpipeOnStdin(exitCode = 1) {
  const ee: any = new EventEmitter();
  ee.stdout = Readable.from([Buffer.alloc(0)]);
  ee.stderr = Readable.from([Buffer.alloc(0)]);
  ee.stdin = new Writable({
    write(_c, _e, cb) {
      const err: any = new Error("write EPIPE");
      err.code = "EPIPE";
      cb(err);
    },
  });
  ee.kill = () => {};
  // Close fires before stdin.end() is called by the implementation.
  process.nextTick(() => ee.emit("close", exitCode));
  return ee;
}

import { detectExtractor, extractContent, __resetExtractorCache } from "../src/lib/extract.js";

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  (spawn as any).mockReset();
  __resetExtractorCache();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("detectExtractor", () => {
  it("prefers trafilatura when both are present", async () => {
    (spawn as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" && args[0] === "trafilatura")
        return fakeChild("/usr/bin/trafilatura\n", 0);
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
      if (cmd === "which" && args[0] === "trafilatura")
        return fakeChild("/usr/bin/trafilatura\n", 0);
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
      if (cmd === "which" && args[0] === "trafilatura")
        return fakeChild("/usr/bin/trafilatura\n", 0);
      return fakeChild("", 1);
    });
    await Promise.all([detectExtractor(), detectExtractor(), detectExtractor()]);
    const whichCalls = (spawn as any).mock.calls.filter((c: any[]) => c[0] === "which");
    expect(whichCalls).toHaveLength(1);
  });
});

describe("extractContent", () => {
  it("invokes trafilatura with --html --no-comments and returns its stdout", async () => {
    (spawn as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" && args[0] === "trafilatura") return fakeChild("/x\n", 0);
      if (cmd === "trafilatura") return fakeChild("<article>clean</article>", 0);
      return fakeChild("", 1);
    });
    const out = await extractContent("<html>...</html>", "https://example.com/a");
    expect(out).toBe("<article>clean</article>");
    const trafCall = (spawn as any).mock.calls.find((c: any[]) => c[0] === "trafilatura");
    expect(trafCall).toBeTruthy();
    expect(trafCall[1]).toEqual(["--html", "--no-comments"]);
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

  it("survives extractor that closes before stdin.end() (EPIPE on write)", async () => {
    (spawn as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" && args[0] === "trafilatura") return fakeChild("/x\n", 0);
      if (cmd === "trafilatura") return fakeChildEpipeOnStdin(2);
      return fakeChild("", 1);
    });
    // The implementation must attach stdin.on("error", ...) before .end(),
    // otherwise the EPIPE bubbles to an unhandled "error" event on the
    // Writable and crashes the test process. The Promise itself just resolves
    // to null (extractor failure path).
    expect(await extractContent("<html>x</html>".repeat(10000), "https://example.com")).toBeNull();
  });

  it("emits a one-shot stderr warning on first extractor failure", async () => {
    (spawn as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" && args[0] === "trafilatura") return fakeChild("/x\n", 0);
      if (cmd === "trafilatura") return fakeChild("", 2, "boom");
      return fakeChild("", 1);
    });
    expect(await extractContent("<html>x</html>", "https://example.com")).toBeNull();
    expect(await extractContent("<html>y</html>", "https://example.com")).toBeNull();
    expect(await extractContent("<html>z</html>", "https://example.com")).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/Extractor "trafilatura" failed/);
  });
});
