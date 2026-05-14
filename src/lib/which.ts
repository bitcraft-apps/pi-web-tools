import { spawn } from "node:child_process";

// Shared by extract.ts, html2md.ts, pdf.ts.

/**
 * Check whether `cmd` is resolvable on $PATH.
 *
 * Uses `which`, which isn't POSIX (`command -v` is). May be missing on slim
 * Alpine / distroless / busybox setups; in those cases this resolves false
 * and callers fall through to their no-binary warning path. If we ever add
 * Windows support, this is the one place that breaks.
 */
export async function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn("which", [cmd], { stdio: ["ignore", "pipe", "pipe"] });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}
