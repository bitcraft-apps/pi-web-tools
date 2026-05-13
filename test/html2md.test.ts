import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

function fakeChild(stdoutText: string, exitCode = 0) {
  const ee: any = new EventEmitter();
  ee.stdout = Readable.from([stdoutText]);
  ee.stderr = Readable.from([""]);
  ee.stdin = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  setImmediate(() => ee.emit("close", exitCode));
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
      if (cmd === "which" && args[0] === "pandoc") return fakeChild("/usr/bin/pandoc\n", 0);
      if (cmd === "pandoc") return fakeChild("# Hello\n", 0);
      return fakeChild("", 1);
    });
    const md = await htmlToMarkdown("<h1>Hello</h1>");
    expect(md).toContain("# Hello");
  });

  it("falls back to w3m if pandoc missing", async () => {
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (cmd === "which" && args[0] === "pandoc") return fakeChild("", 1);
      if (cmd === "which" && args[0] === "w3m") return fakeChild("/usr/bin/w3m\n", 0);
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
      if (cmd === "which" && args[0] === "pandoc") return fakeChild("/usr/bin/pandoc\n", 0);
      if (cmd === "pandoc") return fakeChild("# Hi\n", 0);
      return fakeChild("", 1);
    });
    await htmlToMarkdown("<h1>a</h1>");
    await htmlToMarkdown("<h1>b</h1>");
    await htmlToMarkdown("<h1>c</h1>");
    const whichCalls = vi.mocked(spawn).mock.calls.filter((c) => c[0] === "which");
    expect(whichCalls).toHaveLength(1);
    expect(whichCalls[0]![1][0]).toBe("pandoc");
  });

  it("single-flights concurrent first calls (which spawned only once under parallel load)", async () => {
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (cmd === "which" && args[0] === "pandoc") return fakeChild("/usr/bin/pandoc\n", 0);
      if (cmd === "pandoc") return fakeChild("# Hi\n", 0);
      return fakeChild("", 1);
    });
    await Promise.all([
      htmlToMarkdown("<h1>a</h1>"),
      htmlToMarkdown("<h1>b</h1>"),
      htmlToMarkdown("<h1>c</h1>"),
    ]);
    const whichCalls = vi.mocked(spawn).mock.calls.filter((c) => c[0] === "which");
    expect(whichCalls).toHaveLength(1);
    expect(whichCalls[0]![1][0]).toBe("pandoc");
  });

  it("strips base64 data: URI payloads from pandoc output (issue #127)", async () => {
    const pandocOut = "![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA)\n";
    vi.mocked(spawn).mockImplementation((cmd, args) => {
      if (cmd === "which" && args[0] === "pandoc") return fakeChild("/usr/bin/pandoc\n", 0);
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
      if (cmd === "which" && args[0] === "pandoc") return fakeChild("", 1);
      if (cmd === "which" && args[0] === "w3m") return fakeChild("/usr/bin/w3m\n", 0);
      if (cmd === "w3m") return fakeChild(w3mOut, 0);
      return fakeChild("", 1);
    });
    const md = await htmlToMarkdown(
      '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA">',
    );
    expect(md).toBe("Image: data:image/png;base64,…\n");
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
