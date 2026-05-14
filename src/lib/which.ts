import { spawn } from "node:child_process";

// Shared by extract.ts, html2md.ts, pdf.ts.

/**
 * Check whether `cmd` is resolvable on $PATH.
 *
 * Uses POSIX `command -v` via `sh -c`, which is a builtin in every POSIX
 * shell (including busybox ash on Alpine/distroless). `which` is not POSIX
 * and is missing on slim images, so we avoid it.
 *
 * On a fully stripped image like `gcr.io/distroless/static`, `sh` itself
 * may be absent; spawn then emits `error` and we resolve `false`. That's
 * the right answer for our callers (pandoc/w3m/pdftotext/extractors can't
 * run there either), so no special-casing is needed.
 *
 * `cmd` is passed as a positional shell argument (`$1`), never interpolated
 * into the script body, so callers can't inject shell syntax.
 *
 * If we ever add Windows support, this is the one place that breaks.
 */
export async function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "_", cmd], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}
