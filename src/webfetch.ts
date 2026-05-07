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
import { Type } from "@mariozechner/pi-ai";
import { defineTool } from "@mariozechner/pi-coding-agent";

export interface FetchInput {
  url: string;
  max_chars?: number;
}

const HTML_MIMES = ["text/html", "application/xhtml+xml"];
const HTML_SNIFF_BYTES = 1024;

type BodyKind = "html" | "json" | "text";

function parseCharset(contentType: string): string | undefined {
  const m = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return m?.[1];
}

// Sniff a <meta> charset declaration in the first HTML_SNIFF_BYTES of the body.
// Catches both <meta charset="..."> and <meta http-equiv="Content-Type" content="...; charset=...">.
// We tokenize each <meta> tag's attributes, so a charset= substring sitting inside an unrelated
// quoted attribute value (e.g. <meta name="description" content="...charset=utf-8...">) cannot win.
// HTML comments are stripped first; an unterminated <!-- inside the sniff window truncates the
// buffer to be safe so a commented-out meta cannot leak through.
// Note: this does not implement the WHATWG step "if meta says utf-16, force utf-8". HTTP charset
// already takes precedence above, and a utf-16 meta in an ASCII-decoded sniff buffer is vanishingly
// rare in practice; tryDecode falls back to utf-8 on a bogus label anyway.
function sniffHtmlMetaCharset(buf: ArrayBuffer): string | undefined {
  const head = new Uint8Array(buf, 0, Math.min(HTML_SNIFF_BYTES, buf.byteLength));
  // windows-1252 is byte-preserving for ASCII and universally supported; meta declarations are pure ASCII.
  const raw = new TextDecoder("windows-1252").decode(head);
  let text = raw.replace(/<!--[\s\S]*?-->/g, "");
  const unterminated = text.indexOf("<!--");
  if (unterminated !== -1) text = text.slice(0, unterminated);

  const metaRe = /<meta\b([^>]*)>/gi;
  const attrRe = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
  for (let tag; (tag = metaRe.exec(text)) !== null; ) {
    const attrs: Record<string, string> = {};
    for (let a; (a = attrRe.exec(tag[1])) !== null; ) {
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    }
    if (attrs.charset) return attrs.charset;
    if (attrs["http-equiv"]?.toLowerCase() === "content-type" && attrs.content) {
      const inner = /charset\s*=\s*([A-Za-z0-9_:.\-+]+)/i.exec(attrs.content);
      if (inner) return inner[1];
    }
  }
  return undefined;
}

function tryDecode(buf: ArrayBuffer, charset: string): string | undefined {
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return undefined;
  }
}

function pickCharset(
  response: Response,
  buf: ArrayBuffer,
  kind: BodyKind,
): string | undefined {
  const httpCharset = parseCharset(response.headers.get("content-type") ?? "");
  if (httpCharset) return httpCharset;
  if (kind === "html") return sniffHtmlMetaCharset(buf);
  return undefined;
}

async function decodeBody(
  response: Response,
  kind: BodyKind,
): Promise<string> {
  const buf = await response.arrayBuffer();
  const charset = pickCharset(response, buf, kind);
  if (charset) {
    const decoded = tryDecode(buf, charset);
    if (decoded !== undefined) return decoded;
    // unknown encoding label — fall through to utf-8
  }
  return new TextDecoder("utf-8").decode(buf);
}

function classifyMime(ct: string): BodyKind | "binary" {
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

  const body = await decodeBody(response, kind);

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

export const webfetchTool = defineTool({
  name: "webfetch",
  label: "Web Fetch",
  description:
    "Fetch a URL and return its main text content as markdown. HTML is converted via pandoc or w3m. Use after `websearch` to read full content of a result, or directly when user gives you a URL. Cannot fetch binary content (PDF, images). Cannot reach localhost or RFC1918 link-local addresses.",
  parameters: Type.Object({
    url: Type.String({ description: "Absolute http(s) URL to fetch." }),
    max_chars: Type.Optional(
      Type.Number({
        description: `Truncate output at N chars (default ${MAX_CHARS_DEFAULT}, hard cap ${MAX_CHARS_HARD_CAP}).`,
        default: MAX_CHARS_DEFAULT,
      }),
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, _ctx) {
    const md = await fetchAsMarkdown({ url: params.url, max_chars: params.max_chars });
    return {
      content: [{ type: "text", text: md }],
      details: { url: params.url, chars: md.length },
    };
  },
});
