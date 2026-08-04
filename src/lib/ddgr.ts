import { runCommandRaw } from "./run-command.ts";

const NOT_INSTALLED =
  "ddgr not installed. Run: brew install ddgr (mac) / pip install ddgr / apt install ddgr";

export interface DdgrResult {
  title: string;
  url: string;
  snippet: string;
}

const SNIPPET_MAX = 240;
const TIMEOUT_MS = 15_000;

export function parseOutput(stdout: string, limit: number): DdgrResult[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to parse ddgr output: ${msg}`, { cause: e });
  }
  if (!Array.isArray(raw)) {
    throw new Error("ddgr output is not a JSON array");
  }
  return raw.slice(0, limit).map((r: any) => ({
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    snippet: String(r.abstract ?? "").slice(0, SNIPPET_MAX),
  }));
}

export type SafeSearch = "off" | "moderate" | "strict";
export type TimeFilter = "d" | "w" | "m" | "y";

export interface RunDdgrOptions {
  /**
   * Maps to ddgr's `--reg`. Checked twice on purpose: websearch.ts's schema
   * carries the same shape as a `pattern` (#248), and REGION_PATTERN below
   * re-checks it here. The schema is not enough on its own — sampling is
   * constrained on a best-effort basis (`strict: "prefer"`), and this function
   * is exported, so a direct caller never passes through schema validation at
   * all.
   */
  region?: string;
  safesearch?: SafeSearch;
  /**
   * Maps to ddgr's `-t/--time`. Restrict results to the past day/week/month/year.
   * Omitted → no time filter (ddgr default = all time). Still validated at the
   * schema boundary (websearch.ts's literal union, which strict mode allows) so
   * this layer trusts the value.
   */
  time?: TimeFilter;
}

/**
 * Region codes we pass through to ddgr. Anything else is dropped rather than
 * rejected, matching the documented behavior ("unknown codes fall back to
 * ddgr's default") and keeping non-region-shaped strings out of argv.
 *
 * Exported so websearch.ts's schema can emit `pattern: REGION_PATTERN.source`
 * instead of a second hand-written copy of the same regex. Keep it flag-free:
 * `.source` drops flags, so a `/i` here would loosen the runtime check while
 * the schema stayed strict.
 */
export const REGION_PATTERN = /^[a-z]{2}-[a-z]{2}$/;

export function buildDdgrArgs(query: string, limit: number, opts: RunDdgrOptions = {}): string[] {
  const args = ["--json", "--num", String(limit), "--noprompt"];
  const region = opts.region?.trim();
  if (region && REGION_PATTERN.test(region)) {
    args.push("--reg", region);
  }
  if (opts.safesearch === "off") {
    args.push("--unsafe");
  }
  // `--time <bucket>` mirrors `--reg`'s shape: opt-in, no default emitted, value
  // already validated upstream by the typebox literal union in websearch.ts.
  if (opts.time) {
    args.push("--time", opts.time);
  }
  args.push("--", query);
  return args;
}

export async function runDdgr(
  query: string,
  limit: number,
  opts: RunDdgrOptions = {},
): Promise<DdgrResult[]> {
  let result;
  try {
    // No stdin: ddgr takes the query on argv. Exit code is deliberately not
    // checked — ddgr exits non-zero in cases where it still printed usable
    // JSON, so `runCommandRaw` (not `runCommand`) is the right primitive and
    // empty stdout is our failure signal.
    result = await runCommandRaw("ddgr", buildDdgrArgs(query, limit, opts), {
      timeoutMs: TIMEOUT_MS,
      timeoutMessage:
        "DuckDuckGo timed out (likely rate-limited). Try again in a minute or use webfetch with a known URL.",
    });
  } catch (e: any) {
    // Covers both spawn failure paths: the synchronous throw and the `error`
    // event. `runCommandRaw` rejects with the raw error, so `code` survives.
    if (e?.code === "ENOENT") throw new Error(NOT_INSTALLED, { cause: e });
    throw e;
  }
  const stdout = result.stdout.trim();
  if (!stdout) {
    const stderr = result.stderr.trim();
    throw new Error(`ddgr produced no output (exit ${result.code}): ${stderr || "(empty stderr)"}`);
  }
  return parseOutput(stdout, limit);
}
