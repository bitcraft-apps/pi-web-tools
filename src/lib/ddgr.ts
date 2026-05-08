import { spawn } from "node:child_process";

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

export interface RunDdgrOptions {
  region?: string;
  safesearch?: SafeSearch;
}

export function buildDdgrArgs(query: string, limit: number, opts: RunDdgrOptions = {}): string[] {
  const args = ["--json", "--num", String(limit), "--noprompt"];
  const region = opts.region?.trim();
  if (region) {
    args.push("--reg", region);
  }
  if (opts.safesearch === "off") {
    args.push("--unsafe");
  }
  args.push("--", query);
  return args;
}

export async function runDdgr(
  query: string,
  limit: number,
  opts: RunDdgrOptions = {},
): Promise<DdgrResult[]> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("ddgr", buildDdgrArgs(query, limit, opts), {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: any) {
      if (e.code === "ENOENT") {
        return reject(
          new Error(
            "ddgr not installed. Run: brew install ddgr (mac) / pip install ddgr / apt install ddgr",
          ),
        );
      }
      return reject(e);
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, TIMEOUT_MS);

    child.stdout.on("data", (c) => stdoutChunks.push(c));
    child.stderr.on("data", (c) => stderrChunks.push(c));

    child.on("error", (err: any) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        return reject(
          new Error(
            "ddgr not installed. Run: brew install ddgr (mac) / pip install ddgr / apt install ddgr",
          ),
        );
      }
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(
          new Error(
            "DuckDuckGo timed out (likely rate-limited). Try again in a minute or use webfetch with a known URL.",
          ),
        );
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
      if (!stdout) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
        return reject(
          new Error(`ddgr produced no output (exit ${code}): ${stderr || "(empty stderr)"}`),
        );
      }
      try {
        resolve(parseOutput(stdout, limit));
      } catch (e) {
        reject(e);
      }
    });
  });
}
