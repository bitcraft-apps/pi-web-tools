import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { isWhichSpawn, whichSpawnTarget } from "./_helpers/spawn.js";

function fakeChild(stdoutText: string, exitCode = 0, stderrText = "") {
  // Readable.from([string]) yields strings; the implementation expects Buffers
  // (matches real `spawn` behavior with no setEncoding call).
  return fakeChildFromChunks([Buffer.from(stdoutText, "utf-8")], exitCode, stderrText);
}

/**
 * Like `fakeChild`, but lets the caller control the exact stdout chunking —
 * needed to model a multi-byte codepoint split across two reads.
 */
function fakeChildFromChunks(stdoutChunks: Buffer[], exitCode = 0, stderrText = "") {
  const ee: any = new EventEmitter();
  ee.stdout = Readable.from(stdoutChunks);
  ee.stderr = Readable.from([Buffer.from(stderrText, "utf-8")]);
  ee.stdin = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  ee.kill = () => {};
  // Emit "close" *after* stdout drains, so the implementation's data handlers
  // have populated stdoutChunks before close fires. resume() forces flow even
  // when the consumer (e.g. commandExists) doesn't attach a data listener —
  // mirrors real `spawn`, where the OS pipe closes regardless of consumption.
  ee.stdout.on("end", () => ee.emit("close", exitCode));
  setImmediate(() => {
    ee.stdout.resume();
    ee.stderr.resume();
  });
  return ee;
}

import { htmlToMarkdown, stripBase64DataUris, __resetConverterCache } from "../src/lib/html2md.js";

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  __resetConverterCache();
});

describe("htmlToMarkdown", () => {
  it("converts HTML using pandoc when available", async () => {
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (isWhichSpawn(cmd, args, "pandoc")) return fakeChild("/usr/bin/pandoc\n", 0);
      if (cmd === "pandoc") return fakeChild("# Hello\n", 0);
      return fakeChild("", 1);
    });
    const md = await htmlToMarkdown("<h1>Hello</h1>");
    expect(md).toContain("# Hello");
  });

  it("falls back to w3m if pandoc missing", async () => {
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (isWhichSpawn(cmd, args, "pandoc")) return fakeChild("", 1);
      if (isWhichSpawn(cmd, args, "w3m")) return fakeChild("/usr/bin/w3m\n", 0);
      if (cmd === "w3m") return fakeChild("Hello\n", 0);
      return fakeChild("", 1);
    });
    const md = await htmlToMarkdown("<h1>Hello</h1>");
    expect(md).toContain("Hello");
  });

  it("throws if neither pandoc nor w3m installed", async () => {
    vi.mocked(spawn).mockImplementation(() => fakeChild("", 1));
    await expect(htmlToMarkdown("<p>x</p>")).rejects.toThrow(/pandoc or w3m/i);
  });

  it("memoizes converter detection across calls (which spawned only once)", async () => {
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (isWhichSpawn(cmd, args, "pandoc")) return fakeChild("/usr/bin/pandoc\n", 0);
      if (cmd === "pandoc") return fakeChild("# Hi\n", 0);
      return fakeChild("", 1);
    });
    await htmlToMarkdown("<h1>a</h1>");
    await htmlToMarkdown("<h1>b</h1>");
    await htmlToMarkdown("<h1>c</h1>");
    const probes = vi
      .mocked(spawn)
      .mock.calls.map(whichSpawnTarget)
      .filter((t): t is string => t !== undefined);
    expect(probes).toEqual(["pandoc"]);
  });

  it("single-flights concurrent first calls (which spawned only once under parallel load)", async () => {
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (isWhichSpawn(cmd, args, "pandoc")) return fakeChild("/usr/bin/pandoc\n", 0);
      if (cmd === "pandoc") return fakeChild("# Hi\n", 0);
      return fakeChild("", 1);
    });
    await Promise.all([
      htmlToMarkdown("<h1>a</h1>"),
      htmlToMarkdown("<h1>b</h1>"),
      htmlToMarkdown("<h1>c</h1>"),
    ]);
    const probes = vi
      .mocked(spawn)
      .mock.calls.map(whichSpawnTarget)
      .filter((t): t is string => t !== undefined);
    expect(probes).toEqual(["pandoc"]);
  });

  it("strips base64 data: URI payloads from pandoc output (issue #127)", async () => {
    const pandocOut = "![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA)\n";
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (isWhichSpawn(cmd, args, "pandoc")) return fakeChild("/usr/bin/pandoc\n", 0);
      if (cmd === "pandoc") return fakeChild(pandocOut, 0);
      return fakeChild("", 1);
    });
    const md = await htmlToMarkdown(
      '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA">',
    );
    expect(md).toBe("![](data:image/png;base64,…)\n");
  });

  it("strips base64 data: URI payloads from w3m output too (issue #127)", async () => {
    const w3mOut = "Image: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA\n";
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (isWhichSpawn(cmd, args, "pandoc")) return fakeChild("", 1);
      if (isWhichSpawn(cmd, args, "w3m")) return fakeChild("/usr/bin/w3m\n", 0);
      if (cmd === "w3m") return fakeChild(w3mOut, 0);
      return fakeChild("", 1);
    });
    const md = await htmlToMarkdown(
      '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA">',
    );
    expect(md).toBe("Image: data:image/png;base64,…\n");
  });

  it("decodes multi-byte codepoints split across stdout chunks (no mojibake)", async () => {
    // "# Café — naïve\n" chopped mid-sequence: the first chunk ends halfway
    // through the é, and the em dash is split too. Per-chunk toString("utf-8")
    // turns both into U+FFFD; decoding once at close does not.
    const full = Buffer.from("# Café — naïve\n", "utf-8");
    const eAcuteStart = full.indexOf(0xc3); // first byte of "é"
    const emDashMid = full.indexOf(0x80, full.indexOf(0xe2)); // middle of "—"
    const chunks = [
      full.subarray(0, eAcuteStart + 1),
      full.subarray(eAcuteStart + 1, emDashMid),
      full.subarray(emDashMid),
    ];
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (isWhichSpawn(cmd, args, "pandoc")) return fakeChild("/usr/bin/pandoc\n", 0);
      if (cmd === "pandoc") return fakeChildFromChunks(chunks, 0);
      return fakeChild("", 1);
    });
    const md = await htmlToMarkdown("<h1>Café — naïve</h1>");
    expect(md).toBe("# Café — naïve\n");
    expect(md).not.toContain("�");
  });

  it("rejects when converter stdout exceeds the byte cap (overflow path)", async () => {
    // Two 30 MB chunks → 60 MB, over the 50 MB cap. The first chunk is under
    // it; the second trips the overflow branch, which kills the child and
    // rejects with the cap message.
    function overflowChild() {
      const ee: any = new EventEmitter();
      const big = Buffer.alloc(30 * 1024 * 1024);
      ee.stdout = Readable.from([big, big]);
      ee.stderr = Readable.from([Buffer.alloc(0)]);
      ee.stdin = new Writable({
        write(_c, _e, cb) {
          cb();
        },
      });
      ee.kill = () => {};
      ee.stdout.on("end", () => ee.emit("close", null));
      setImmediate(() => {
        ee.stdout.resume();
        ee.stderr.resume();
      });
      return ee;
    }
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (isWhichSpawn(cmd, args, "pandoc")) return fakeChild("/usr/bin/pandoc\n", 0);
      if (cmd === "pandoc") return overflowChild();
      return fakeChild("", 1);
    });
    await expect(htmlToMarkdown("<p>x</p>")).rejects.toThrow(/stdout exceeded/i);
  });

  it("survives a converter that closes before stdin.end() (EPIPE on write)", async () => {
    // Models a converter killed / crashed mid-input. The implementation must
    // attach stdin.on("error", ...) before .end(), otherwise the EPIPE bubbles
    // to an unhandled "error" event on the Writable and takes down the process.
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
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (isWhichSpawn(cmd, args, "pandoc")) return fakeChild("/usr/bin/pandoc\n", 0);
      if (cmd === "pandoc") return fakeChildEpipeOnStdin(1);
      return fakeChild("", 1);
    });
    await expect(htmlToMarkdown("<p>x</p>")).rejects.toThrow(/exited with code 1/);
  });

  it("rejects when the converter exceeds the timeout", async () => {
    vi.useFakeTimers();
    try {
      // Child that never closes on its own — only kill() (from the timeout
      // branch) makes it close.
      function hangingChild() {
        const ee: any = new EventEmitter();
        ee.stdout = new Readable({ read() {} });
        ee.stderr = new Readable({ read() {} });
        ee.stdin = new Writable({
          write(_c, _e, cb) {
            cb();
          },
        });
        ee.kill = () => {
          ee.stdout.push(null);
          ee.stderr.push(null);
          setImmediate(() => ee.emit("close", null));
        };
        return ee;
      }
      vi.mocked(spawn).mockImplementation((cmd, args) => {
        if (isWhichSpawn(cmd, args, "pandoc")) return fakeChild("/usr/bin/pandoc\n", 0);
        if (cmd === "pandoc") return hangingChild();
        return fakeChild("", 1);
      });
      const p = htmlToMarkdown("<p>x</p>");
      const assertion = expect(p).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(11_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stripBase64DataUris", () => {
  it("strips inline SVG payloads, keeps MIME tag", () => {
    const md =
      "icon: ![logo](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=)";
    expect(stripBase64DataUris(md)).toBe("icon: ![logo](data:image/svg+xml;base64,…)");
  });

  it("strips PNG payloads", () => {
    const md =
      "![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=)";
    expect(stripBase64DataUris(md)).toBe("![](data:image/png;base64,…)");
  });

  it("strips font payloads (woff2)", () => {
    const md =
      "@font-face { src: url(data:application/font-woff2;base64,d09GMgABAAAAAAhMAA4AAAAAEXgAAAf6AAEAAAAAAAAAAAAA) }";
    expect(stripBase64DataUris(md)).toBe(
      "@font-face { src: url(data:application/font-woff2;base64,…) }",
    );
  });

  it("strips inside href= attributes left in passthrough HTML", () => {
    const md = '<a href="data:application/octet-stream;base64,SGVsbG8gV29ybGQh">download</a>';
    expect(stripBase64DataUris(md)).toBe(
      '<a href="data:application/octet-stream;base64,…">download</a>',
    );
  });

  it("strips multiple URIs in one document independently", () => {
    const md = "a ![](data:image/png;base64,AAAA) b ![](data:image/jpeg;base64,BBBB) c";
    expect(stripBase64DataUris(md)).toBe(
      "a ![](data:image/png;base64,…) b ![](data:image/jpeg;base64,…) c",
    );
  });

  it("preserves MIME parameters like charset", () => {
    const md = "![](data:image/svg+xml;charset=utf-8;base64,PHN2Zy8+)";
    expect(stripBase64DataUris(md)).toBe("![](data:image/svg+xml;charset=utf-8;base64,…)");
  });

  it("leaves non-base64 data: URIs untouched (they can carry readable content)", () => {
    const md = "[hi](data:text/plain,Hello%20world) and ![](data:image/svg+xml,<svg/>)";
    expect(stripBase64DataUris(md)).toBe(md);
  });

  it("does not match URLs that merely contain the substring 'base64'", () => {
    const md = "see https://example.com/base64/guide and `base64 -d`";
    expect(stripBase64DataUris(md)).toBe(md);
  });

  it("is a no-op on documents with no data: URIs", () => {
    const md = "# Hello\n\nA paragraph with [a link](https://example.com).\n";
    expect(stripBase64DataUris(md)).toBe(md);
  });
});
