import { spawn } from "node:child_process";

// Same backstop as html2md's CONVERT_TIMEOUT_MS. Note: webfetch now chains
// extractor → pandoc/w3m, so worst-case subprocess time per HTML fetch is ~20s.
// Real-world per-call subprocess time is in the tens of ms; the timeout is a
// catastrophe backstop, not a routine bound.
const EXTRACT_TIMEOUT_MS = 10_000;

export type Extractor = "trafilatura" | "rdrview";

let cachedDetection: Promise<Extractor | null> | undefined;
let warnedNoExtractor = false;

async function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("which", [cmd], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve(false);
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

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

/** Test-only: clear the cached extractor detection and the one-shot warning latch. */
export function __resetExtractorCache(): void {
  cachedDetection = undefined;
  warnedNoExtractor = false;
}

function runExtractor(cmd: string, args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return reject(e);
    }
    const stdoutChunks: (Buffer | string)[] = [];
    const stderrChunks: (Buffer | string)[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, EXTRACT_TIMEOUT_MS);

    child.stdout.on("data", (c: Buffer | string) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer | string) => stderrChunks.push(c));
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${cmd} timed out`));
      if (code !== 0) {
        const stderr = stderrChunks.map((c) => (Buffer.isBuffer(c) ? c.toString("utf-8") : c)).join("");
        return reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
      }
      resolve(stdoutChunks.map((c) => (Buffer.isBuffer(c) ? c.toString("utf-8") : c)).join(""));
    });

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
      // --precision: favor extraction precision over recall; chrome-stripping is
      //   the goal, agent can re-fetch a different URL if content's missing.
      // NOTE: trafilatura has no documented way to absolutify relative links
      //   when reading stdin; output keeps relative hrefs. rdrview's -u resolves.
      return await runExtractor(
        "trafilatura",
        ["--html", "--no-comments", "--precision"],
        html,
      );
    }
    // rdrview: -H = output cleaned HTML, -u = base URL for relative-link resolution.
    // No positional path/url means "read HTML from stdin" per rdrview(1).
    // --disable-sandbox: macOS rdrview has no sandbox implemented; the flag is
    // required there. On Linux/BSD the seccomp/Pledge/Capsicum sandbox is left
    // enabled (we're feeding it HTML downloaded from arbitrary remote URLs).
    const args = ["-H", "-u", url];
    if (process.platform === "darwin") args.push("--disable-sandbox");
    return await runExtractor("rdrview", args, html);
  } catch {
    return null;
  }
}
