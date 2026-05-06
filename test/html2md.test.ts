import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { htmlToMarkdown } from "../src/lib/html2md.js";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

function fakeChild(stdoutText: string, exitCode = 0) {
  const ee: any = new EventEmitter();
  ee.stdout = Readable.from([stdoutText]);
  ee.stderr = Readable.from([""]);
  ee.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  setImmediate(() => ee.emit("close", exitCode));
  return ee;
}

beforeEach(() => {
  (spawn as any).mockReset();
});

describe("htmlToMarkdown", () => {
  it("converts HTML using pandoc when available", async () => {
    (spawn as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" && args[0] === "pandoc") return fakeChild("/usr/bin/pandoc\n", 0);
      if (cmd === "pandoc") return fakeChild("# Hello\n", 0);
      return fakeChild("", 1);
    });
    const md = await htmlToMarkdown("<h1>Hello</h1>");
    expect(md).toContain("# Hello");
  });

  it("falls back to w3m if pandoc missing", async () => {
    (spawn as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" && args[0] === "pandoc") return fakeChild("", 1);
      if (cmd === "which" && args[0] === "w3m") return fakeChild("/usr/bin/w3m\n", 0);
      if (cmd === "w3m") return fakeChild("Hello\n", 0);
      return fakeChild("", 1);
    });
    const md = await htmlToMarkdown("<h1>Hello</h1>");
    expect(md).toContain("Hello");
  });

  it("throws if neither pandoc nor w3m installed", async () => {
    (spawn as any).mockImplementation(() => fakeChild("", 1));
    await expect(htmlToMarkdown("<p>x</p>")).rejects.toThrow(/pandoc or w3m/i);
  });
});
