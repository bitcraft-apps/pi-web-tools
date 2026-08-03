import { spawn } from "node:child_process";

// Shared by extract.ts, html2md.ts, pdf.ts, ddgr.ts. Four call sites used to
// hand-roll this wrapper; the copies drifted, and the weakest one lost its byte
// cap, its stdin error handler, and decode-once (see issue #203). Keep the
// subprocess plumbing here so a new call site gets all of it by construction.

/**
 * 50 MB peak-memory backstop on child stdout. Every current call site emits
 * output smaller than its input on realistic data, so this only fires on a
 * runaway child. Combined with the per-call-site timeout it keeps a misbehaving
 * child from doubling peak heap (the input is already in memory in the caller).
 */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export interface RunCommandOptions {
  /**
   * Omitted → child stdin is `"ignore"`. Present → `"pipe"`, written and ended.
   */
  stdin?: string | Uint8Array;
  timeoutMs: number;
  /** Defaults to {@link DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
  /** Replaces the default `${cmd} timed out` rejection message. */
  timeoutMessage?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Run `cmd` and collect its output.
 *
 * Rejects if the spawn fails, the child exceeds `timeoutMs`, or its stdout
 * exceeds `maxBytes`. A non-zero exit code **resolves** — the caller decides
 * what it means. Use {@link runCommand} for the usual "non-zero is a failure"
 * contract.
 *
 * Spawn failures reject with the raw error, so callers can read `err.code`
 * (ddgr.ts maps `ENOENT` to its own install hint).
 */
export function runCommandRaw(
  cmd: string,
  args: string[],
  opts: RunCommandOptions,
): Promise<CommandResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return reject(e);
    }
    // stdout/stderr are "pipe" on both branches above, so both streams exist.
    // TypeScript can't see that: the computed stdin entry widens the `spawn`
    // overload to the one where every stream is nullable.
    const childStdout = child.stdout!;
    const childStderr = child.stderr!;
    // Collect Buffers and decode once at close: per-chunk toString("utf-8")
    // mojibakes when a multi-byte codepoint straddles a chunk boundary.
    // No setEncoding() on stdout/stderr, so chunks are always Buffers.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let overflowed = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);

    childStdout.on("data", (c: Buffer) => {
      // Once we've decided to abort (overflow or timeout), drop further chunks
      // on the floor — otherwise the child can keep firing data events between
      // SIGTERM and close, repeatedly clearing chunks and re-calling kill.
      // Harmless but wasteful.
      if (overflowed || timedOut) return;
      stdoutBytes += c.length;
      if (stdoutBytes > maxBytes) {
        overflowed = true;
        // Drop already-buffered chunks immediately so a misbehaving child in a
        // long-lived agent process doesn't keep ~50 MB live until the close
        // handler runs and the Promise rejects.
        stdoutChunks.length = 0;
        child.kill("SIGTERM");
        return;
      }
      stdoutChunks.push(c);
    });
    childStderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Overflow is checked first: the overflow kill also yields a non-zero
      // (or null) exit code, and the cap message is the useful one.
      if (overflowed) return reject(new Error(`${cmd} stdout exceeded ${maxBytes} bytes`));
      if (timedOut) return reject(new Error(opts.timeoutMessage ?? `${cmd} timed out`));
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        code,
      });
    });

    if (opts.stdin !== undefined) {
      const childStdin = child.stdin!;
      // Swallow EPIPE/ECONNRESET on stdin: the child may exit before consuming
      // the full input (timeout, overflow kill, crash, or an early bailout).
      // Without this handler node treats the writable's "error" as unhandled
      // and crashes the process. The close/error/timeout paths above already
      // produce the right Promise outcome.
      childStdin.on("error", () => {});
      // Node's writable.end() accepts a Uint8Array directly — no Buffer wrapper
      // needed (Buffer is a Uint8Array subclass, not a required input type).
      childStdin.end(opts.stdin);
    }
  });
}

/**
 * Run `cmd` and return its stdout. Rejects on everything
 * {@link runCommandRaw} rejects on, plus any non-zero exit code.
 */
export async function runCommand(
  cmd: string,
  args: string[],
  opts: RunCommandOptions,
): Promise<string> {
  const { stdout, stderr, code } = await runCommandRaw(cmd, args, opts);
  if (code !== 0) {
    throw new Error(`${cmd} exited with code ${code}: ${stderr}`);
  }
  return stdout;
}
