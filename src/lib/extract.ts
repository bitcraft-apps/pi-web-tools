import { commandExists, probeOnce } from "./which.js";
import { runCommand } from "./run-command.js";

// Same backstop as html2md's CONVERT_TIMEOUT_MS. Note: webfetch now chains
// extractor → pandoc/w3m, so worst-case subprocess time per HTML fetch is ~20s.
// Real-world per-call subprocess time is in the tens of ms; the timeout is a
// catastrophe backstop, not a routine bound.
const EXTRACT_TIMEOUT_MS = 10_000;

export type Extractor = "trafilatura" | "rdrview";

// --html: emit cleaned HTML so the existing pandoc/w3m step gives a single
//   canonical markdown style across extractor-on/off paths.
// Default precision/recall balance: --precision was tried but biases
//   toward dropping borderline content (tables, code blocks adjacent to
//   the article body). Revisit if chrome leakage is too high in practice.
// NOTE: trafilatura has no documented way to absolutify relative links
//   when reading stdin; output keeps relative hrefs. rdrview's -u resolves.
//
// Exported for test/contract/, which runs the real binary with this argv.
export const TRAFILATURA_ARGS = ["--html"];

/**
 * argv for rdrview on `url`.
 *
 * -H = output cleaned HTML, -u = base URL for relative-link resolution.
 * No positional path/url means "read HTML from stdin" per rdrview(1).
 * --disable-sandbox: macOS rdrview has no sandbox implemented; the flag is
 * required there. Consequence: macOS users get an *unsandboxed* parse of
 * attacker-controlled HTML. On Linux/BSD the seccomp/Pledge/Capsicum
 * sandbox is left enabled. This asymmetry is the main reason trafilatura
 * is probed first; revisit detection order if/when an rdrview brew formula
 * (with a working macOS sandbox) lands.
 *
 * Exported for test/contract/, which runs the real binary with this argv.
 */
export function rdrviewArgs(url: string): string[] {
  const args = ["-H", "-u", url];
  if (process.platform === "darwin") args.push("--disable-sandbox");
  return args;
}

let warnedNoExtractor = false;
let warnedExtractorFailure = false;

export const detectExtractor = probeOnce(async (): Promise<Extractor | null> => {
  // trafilatura first: `pipx install trafilatura` is the install path that
  // actually works cross-platform. rdrview has no homebrew formula and
  // requires --disable-sandbox on macOS (no sandbox implemented there).
  // Order can flip later if we ship a brew formula upstream for rdrview.
  if (await commandExists("trafilatura")) return "trafilatura";
  if (await commandExists("rdrview")) return "rdrview";
  return null;
});

/** Test-only: clear the cached extractor detection and the one-shot warning latches. */
export function __resetExtractorCache(): void {
  detectExtractor.reset();
  warnedNoExtractor = false;
  warnedExtractorFailure = false;
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
      return await runCommand("trafilatura", TRAFILATURA_ARGS, {
        stdin: html,
        timeoutMs: EXTRACT_TIMEOUT_MS,
      });
    }
    return await runCommand("rdrview", rdrviewArgs(url), {
      stdin: html,
      timeoutMs: EXTRACT_TIMEOUT_MS,
    });
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
