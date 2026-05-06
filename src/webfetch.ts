import { validateUrl } from "./lib/url-guard.js";
import { htmlToMarkdown } from "./lib/html2md.js";
import {
  ACCEPT_HEADER,
  BROWSER_UA,
  FETCH_TIMEOUT_MS,
  MAX_CHARS_DEFAULT,
  MAX_CHARS_HARD_CAP,
  MAX_RESPONSE_BYTES,
  OPENCODE_UA,
} from "./lib/headers.js";

export interface FetchInput {
  url: string;
  max_chars?: number;
}

const HTML_MIMES = ["text/html", "application/xhtml+xml"];

function classifyMime(ct: string): "html" | "json" | "text" | "binary" {
  const lower = ct.toLowerCase();
  if (HTML_MIMES.some((m) => lower.startsWith(m))) return "html";
  if (lower.startsWith("application/json")) return "json";
  if (
    lower.startsWith("application/pdf") ||
    lower.startsWith("image/") ||
    lower.startsWith("video/") ||
    lower.startsWith("audio/") ||
    lower.startsWith("application/octet-stream")
  ) return "binary";
  // text/plain, text/markdown, text/xml, text/* etc., and missing → text
  return "text";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const total = text.length;
  return (
    text.slice(0, max) +
    `\n\n[TRUNCATED — fetched ${max} chars of ${total} total. Re-call with higher max_chars or different URL to read more.]`
  );
}

async function doFetch(url: URL, userAgent: string): Promise<Response> {
  return fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
    headers: { "User-Agent": userAgent, Accept: ACCEPT_HEADER },
  });
}

async function isCloudflareChallenge(response: Response): Promise<boolean> {
  if (response.headers.get("cf-mitigated") === "challenge") return true;
  if (response.status !== 403) return false;
  const clone = response.clone();
  const body = await clone.text();
  return /just a moment|cf-chl-bypass/i.test(body);
}

export async function fetchAsMarkdown(input: FetchInput): Promise<string> {
  const url = validateUrl(input.url);
  const maxChars = Math.min(
    Math.max(1, input.max_chars ?? MAX_CHARS_DEFAULT),
    MAX_CHARS_HARD_CAP,
  );

  let response = await doFetch(url, BROWSER_UA);

  if (await isCloudflareChallenge(response)) {
    response = await doFetch(url, OPENCODE_UA);
    if (await isCloudflareChallenge(response)) {
      throw new Error("Site requires JS, cannot fetch in shell-only mode (Cloudflare challenge)");
    }
  }

  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const cl = response.headers.get("content-length");
  if (cl && Number(cl) > MAX_RESPONSE_BYTES) {
    throw new Error(`Response too large (${(Number(cl) / 1024 / 1024).toFixed(1)} MB, max 5 MB)`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const kind = classifyMime(contentType);

  if (kind === "binary") {
    const ctShort = contentType.split(";")[0] || "binary";
    throw new Error(`Cannot fetch ${ctShort}. Use a tool that supports binary content.`);
  }

  const body = await response.text();

  if (kind === "json") {
    try {
      const pretty = JSON.stringify(JSON.parse(body), null, 2);
      return truncate("```json\n" + pretty + "\n```", maxChars);
    } catch {
      return truncate(body, maxChars);
    }
  }

  if (kind === "text") {
    return truncate(body, maxChars);
  }

  // html
  const md = await htmlToMarkdown(body);
  return truncate(md, maxChars);
}
