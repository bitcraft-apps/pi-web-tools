import { spawn } from "node:child_process";

const CONVERT_TIMEOUT_MS = 10_000;

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

export type Converter = "pandoc" | "w3m";

let cachedDetection: Promise<Converter | null> | undefined;

export async function detectConverter(): Promise<Converter | null> {
  if (cachedDetection !== undefined) return cachedDetection;
  cachedDetection = (async () => {
    if (await commandExists("pandoc")) return "pandoc";
    if (await commandExists("w3m")) return "w3m";
    return null;
  })();
  return cachedDetection;
}

/** Test-only: clear the cached converter detection. */
export function __resetConverterCache(): void {
  cachedDetection = undefined;
}

function runConverter(cmd: string, args: string[], stdin: string): Promise<string> {
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
    }, CONVERT_TIMEOUT_MS);

    child.stdout.on("data", (c: Buffer | string) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer | string) => stderrChunks.push(c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${cmd} timed out`));
      if (code !== 0) {
        const stderr = stderrChunks
          .map((c) => (Buffer.isBuffer(c) ? c.toString("utf-8") : c))
          .join("");
        return reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
      }
      resolve(stdoutChunks.map((c) => (Buffer.isBuffer(c) ? c.toString("utf-8") : c)).join(""));
    });

    child.stdin.end(stdin);
  });
}

export async function htmlToMarkdown(html: string): Promise<string> {
  const converter = await detectConverter();
  if (!converter) {
    throw new Error("Need pandoc or w3m installed. brew install pandoc");
  }
  if (converter === "pandoc") {
    return runConverter("pandoc", ["-f", "html", "-t", "markdown_strict", "--wrap=none"], html);
  }
  return runConverter("w3m", ["-dump", "-T", "text/html", "-cols", "120"], html);
}
