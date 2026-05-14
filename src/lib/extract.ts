import { spawn } from "node:child_process";
import { commandExists } from "./which.ts";

// Same backstop as html2md's CONVERT_TIMEOUT_MS. Note: webfetch now chains
// extractor → pandoc/w3m, so worst-case subprocess time per HTML fetch is ~20s.
// Real-world per-call subprocess time is in the tens of ms; the timeout is a
// catastrophe backstop, not a routine bound.
const EXTRACT_TIMEOUT_MS = 10_000;

export type Extractor = "trafilatura" | "rdrview";

// 50 MB peak-memory backstop on extractor stdout. Trafilatura should emit
// less than its input on every realistic page; this only fires on a runaway
// extractor (or someone feeding it a 200 MB single-page HTML dump). Combined
// with EXTRACT_TIMEOUT_MS this keeps a misbehaving extractor from doubling
// peak heap (input HTML is already in memory in the caller).
const EXTRACT_MAX_BYTES = 50 * 1024 * 1024;

// Cached for the life of the process. A `null` result (no extractor on $PATH)
// also sticks: an extractor installed mid-process won't be picked up until
// restart. Acceptable for an agent process; do not "fix" by re-probing.
let cachedDetection: Promise<Extractor | null> | undefined;
let warnedNoExtractor = false;
let warnedExtractorFailure = false;

export async function detectExtractor(): Promise<Extractor | null> {
  if (cachedDetection !== undefined) return cachedDetection;
  cachedDetection = (async () => {
    // trafilatura first: `pipx install trafilatura` is the install path that
    // actually works cross-platform. rdrview has no homebrew formula and
    // requires --disable-sandbox on macOS (no sandbox implemented there).
    // Order can flip later if we ship a brew formula upstream for rdrview.
    if (await commandExists("trafilatura")) return "trafilatura";
    if (await commandExists("rdrview")) return "rdrview";
    return null;
  })();
  return cachedDetection;
}

/** Test-only: clear the cached extractor detection and the one-shot warning latches. */
export function __resetExtractorCache(): void {
  cachedDetection = undefined;
  warnedNoExtractor = false;
  warnedExtractorFailure = false;
}

function runExtractor(cmd: string, args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return reject(e);
    }
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
    }, EXTRACT_TIMEOUT_MS);

    child.stdout.on("data", (c: Buffer) => {
      stdoutBytes += c.length;
      if (stdoutBytes > EXTRACT_MAX_BYTES) {
        overflowed = true;
        // Drop already-buffered chunks immediately so a misbehaving extractor
        // in a long-lived agent process doesn't keep ~50 MB live until the
        // close handler runs and the Promise rejects.
        stdoutChunks.length = 0;
        child.kill("SIGTERM");
        return;
      }
      stdoutChunks.push(c);
    });
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (overflowed) return reject(new Error(`${cmd} stdout exceeded ${EXTRACT_MAX_BYTES} bytes`));
      if (timedOut) return reject(new Error(`${cmd} timed out`));
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        return reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
      }
      resolve(Buffer.concat(stdoutChunks).toString("utf-8"));
    });

    // Swallow EPIPE/ECONNRESET on stdin: extractor may exit before consuming
    // the full input (timeout, overflow kill, crash, or just deciding it has
    // enough). Without this handler node treats the writable's "error" as
    // unhandled and crashes the process. The close/error/timeout paths above
    // already produce the right Promise outcome.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

/**
 * Extract the main article content from `html` using whichever extractor is on
 * $PATH. Returns cleaned HTML on success, or `null` if no extractor is
 * available or the extractor failed/timed out. Callers fall back to the full
 * HTML on `null`.
 *
 * Extractor failure is intentionally swallowed: the extractor is an
 * optimization, not a contract. The caller must still produce output.
 */
export async function extractContent(html: string, url: string): Promise<string | null> {
  const ex = await detectExtractor();
  if (!ex) {
    if (!warnedNoExtractor) {
      warnedNoExtractor = true;
      // One-shot stderr warning. Visible to humans running pi locally; never
      // injected into tool output (would be prompt-token noise per call).
      console.warn(
        "[pi-web-tools/webfetch] No content extractor on $PATH. " +
          "Fetches on chrome-heavy pages (GitHub, MDN, news) will be much larger than necessary. " +
          "Install one (recommended): `pipx install trafilatura`, " +
          "or rdrview from https://github.com/eafer/rdrview",
      );
    }
    return null;
  }
  try {
    if (ex === "trafilatura") {
      // --html: emit cleaned HTML so the existing pandoc/w3m step gives a single
      //   canonical markdown style across extractor-on/off paths.
      // --no-comments: drop user-comment threads (noise for our use case).
      // Default precision/recall balance: --precision was tried but biases
      //   toward dropping borderline content (tables, code blocks adjacent to
      //   the article body). Revisit if chrome leakage is too high in practice.
      // NOTE: trafilatura has no documented way to absolutify relative links
      //   when reading stdin; output keeps relative hrefs. rdrview's -u resolves.
      return await runExtractor("trafilatura", ["--html", "--no-comments"], html);
    }
    // rdrview: -H = output cleaned HTML, -u = base URL for relative-link resolution.
    // No positional path/url means "read HTML from stdin" per rdrview(1).
    // --disable-sandbox: macOS rdrview has no sandbox implemented; the flag is
    // required there. Consequence: macOS users get an *unsandboxed* parse of
    // attacker-controlled HTML. On Linux/BSD the seccomp/Pledge/Capsicum
    // sandbox is left enabled. This asymmetry is the main reason trafilatura
    // is probed first; revisit detection order if/when an rdrview brew formula
    // (with a working macOS sandbox) lands.
    const args = ["-H", "-u", url];
    if (process.platform === "darwin") args.push("--disable-sandbox");
    return await runExtractor("rdrview", args, html);
  } catch (err) {
    if (!warnedExtractorFailure) {
      warnedExtractorFailure = true;
      // One-shot stderr warning so a permanently-broken extractor (bad install,
      // version skew, sandbox denial) doesn't silently degrade every fetch.
      // Mirrors the no-extractor warning above; never injected into tool output.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[pi-web-tools/webfetch] Extractor "${ex}" failed; falling back to full HTML. ` +
          `Subsequent failures are silent. First error: ${msg}`,
      );
    }
    return null;
  }
}
