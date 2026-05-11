import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

// Mirrors test/extract.test.ts fakeChild — same scheduling caveats apply
// (close emits after stdout drains, resume forces flow even with no data
// listener attached). See the prose there.
function fakeChild(stdoutText: string, exitCode = 0, stderrText = "") {
  const ee: any = new EventEmitter();
  ee.stdout = Readable.from([Buffer.from(stdoutText, "utf-8")]);
  ee.stderr = Readable.from([Buffer.from(stderrText, "utf-8")]);
  ee.stdin = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  ee.kill = () => {};
  ee.stdout.on("end", () => ee.emit("close", exitCode));
  setImmediate(() => ee.stdout.resume());
  return ee;
}

import { detectPdftotext, pdfToText, __resetPdftotextCache } from "../src/lib/pdf.js";

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  __resetPdftotextCache();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("detectPdftotext", () => {
  it("returns true when pdftotext is on $PATH", async () => {
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (cmd === "which" && args[0] === "pdftotext") return fakeChild("/usr/bin/pdftotext\n", 0);
      return fakeChild("", 1);
    });
    expect(await detectPdftotext()).toBe(true);
  });

  it("returns false when pdftotext is missing", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeChild("", 1));
    expect(await detectPdftotext()).toBe(false);
  });

  it("memoizes detection across calls (which probed at most once)", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeChild("/usr/bin/pdftotext\n", 0));
    await detectPdftotext();
    await detectPdftotext();
    await detectPdftotext();
    const whichCalls = vi.mocked(spawn).mock.calls.filter((c) => c[0] === "which");
    expect(whichCalls).toHaveLength(1);
  });

  it("single-flights concurrent first calls", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeChild("/usr/bin/pdftotext\n", 0));
    await Promise.all([detectPdftotext(), detectPdftotext(), detectPdftotext()]);
    const whichCalls = vi.mocked(spawn).mock.calls.filter((c) => c[0] === "which");
    expect(whichCalls).toHaveLength(1);
  });
});

// Tiny fixed buffer — pdftotext is mocked, so the bytes are never parsed.
// Fresh ArrayBuffer (not the SharedArrayBuffer-typed default .buffer view)
// keeps the input identical to what fetchAsMarkdown produces (readBoundedBody
// returns ArrayBuffer). Hoisted out of the describe block per oxlint's
// consistent-function-scoping rule — it captures nothing.
function fakePdf(): ArrayBuffer {
  const u8 = new TextEncoder().encode("%PDF-1.7 fake");
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

describe("pdfToText", () => {
  it("invokes pdftotext with -layout -enc UTF-8 - - and returns its stdout", async () => {
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (cmd === "which" && args[0] === "pdftotext") return fakeChild("/x\n", 0);
      if (cmd === "pdftotext") return fakeChild("Hello, PDF.", 0);
      return fakeChild("", 1);
    });
    const out = await pdfToText(fakePdf());
    expect(out).toBe("Hello, PDF.");
    const ptCall = vi.mocked(spawn).mock.calls.find((c) => c[0] === "pdftotext");
    expect(ptCall).toBeTruthy();
    // Argument order is load-bearing per pdftotext(1): positional `infile
    // outfile` come last, and `-` for both means stdin/stdout.
    expect(ptCall![1]).toEqual(["-layout", "-enc", "UTF-8", "-", "-"]);
  });

  it("returns null (does not throw) when pdftotext exits non-zero", async () => {
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (cmd === "which" && args[0] === "pdftotext") return fakeChild("/x\n", 0);
      if (cmd === "pdftotext") return fakeChild("", 2, "Syntax Error: Couldn't read xref table");
      return fakeChild("", 1);
    });
    expect(await pdfToText(fakePdf())).toBeNull();
  });

  it("returns null and emits a one-shot stderr warning when pdftotext is absent", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeChild("", 1));
    expect(await pdfToText(fakePdf())).toBeNull();
    expect(await pdfToText(fakePdf())).toBeNull();
    expect(await pdfToText(fakePdf())).toBeNull();
    // Exactly one warning across all three calls — this is the
    // prompt-token-cost guarantee: warning is humans-only, never injected
    // into tool output, never spammed.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/poppler/i);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/pdftotext/);
  });

  it("does not warn when pdftotext is present", async () => {
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (cmd === "which" && args[0] === "pdftotext") return fakeChild("/x\n", 0);
      if (cmd === "pdftotext") return fakeChild("ok", 0);
      return fakeChild("", 1);
    });
    await pdfToText(fakePdf());
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("emits a one-shot stderr warning on first pdftotext failure", async () => {
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (cmd === "which" && args[0] === "pdftotext") return fakeChild("/x\n", 0);
      if (cmd === "pdftotext") return fakeChild("", 2, "boom");
      return fakeChild("", 1);
    });
    expect(await pdfToText(fakePdf())).toBeNull();
    expect(await pdfToText(fakePdf())).toBeNull();
    expect(await pdfToText(fakePdf())).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/pdftotext failed/i);
  });
});
