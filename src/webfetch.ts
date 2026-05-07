import { validateUrl } from "./lib/url-guard.js";
import { htmlToMarkdown } from "./lib/html2md.js";
import { extractContent } from "./lib/extract.js";
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

const MAX_RESPONSE_MB = `${(MAX_RESPONSE_BYTES / 1024 / 1024).toFixed(0)} MB`;

function tooLarge(streamed: boolean): Error {
  return new Error(
    streamed
      ? `Response too large (>${MAX_RESPONSE_MB} streamed, max ${MAX_RESPONSE_MB})`
      : `Response too large (max ${MAX_RESPONSE_MB})`,
  );
}

// Read the response body into an ArrayBuffer, aborting if the running total
// exceeds MAX_RESPONSE_BYTES. The Content-Length pre-check in fetchAsMarkdown
// is a fast-path rejection (saves a connection on honest servers); this
// function is the actual enforcement — a server that omits or lies about
// Content-Length still cannot OOM the agent process.
async function readBoundedBody(response: Response): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    // No streaming body (synthetic Response constructed without a body
    // stream — e.g. tests, custom transports). undici always exposes a
    // body stream for network responses, so this branch is not reached in
    // production, but we still cap it: arrayBuffer() on a synthetic body is
    // bounded by what the caller already buffered, but we don't trust that.
    const buf = await response.arrayBuffer();
    if (buf.byteLength > MAX_RESPONSE_BYTES) throw tooLarge(false);
    return buf;
  }
  // Pre-allocate a single Uint8Array and grow with doubling, so the success
  // path peaks at ~2× the final size during the last realloc instead of 2×
  // from a chunks[] + concat copy. Capacity is bounded by MAX_RESPONSE_BYTES.
  let buf = new Uint8Array(64 * 1024);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const next = total + value.byteLength;
      if (next > MAX_RESPONSE_BYTES) {
        // Cancel the stream so the underlying connection is released; without
        // this, undici keeps the socket alive trying to drain the rest.
        try { await reader.cancel(); } catch { /* already closed */ }
        throw tooLarge(true);
      }
      if (next > buf.byteLength) {
        let cap = buf.byteLength;
        while (cap < next) cap *= 2;
        if (cap > MAX_RESPONSE_BYTES) cap = MAX_RESPONSE_BYTES;
        const grown = new Uint8Array(cap);
        grown.set(buf.subarray(0, total));
        buf = grown;
      }
      buf.set(value, total);
      total = next;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  // Hand back a tight slice so decodeBody's TextDecoder doesn't see padding.
  return buf.buffer.slice(0, total);
}

async function decodeBody(
  response: Response,
  kind: BodyKind,
): Promise<string> {
  const buf = await readBoundedBody(response);
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

const MAX_REDIRECTS = 5;

// Single-hop fetch — does NOT follow redirects. Caller is responsible for
// re-validating Location targets and looping. See fetchWithRedirects.
async function doFetch(url: URL, userAgent: string): Promise<Response> {
  return fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "manual",
    headers: { "User-Agent": userAgent, Accept: ACCEPT_HEADER },
  });
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

// Follow up to MAX_REDIRECTS hops, re-running validateUrl on each Location.
// Without this, `redirect: "follow"` would silently bypass the SSRF guard:
// a public host can 302 to http://10.0.0.1, http://169.254.169.254 (AWS IMDS),
// http://localhost, etc., and the URL guard only saw the original input.
//
// Cap of 5 is stricter than undici/Node fetch's default of 20 — webfetch is
// for human-readable pages, not auth dances; chains longer than 5 are almost
// always misconfigurations or loops.
//
// webfetch is GET-only, so RFC 7231 method-downgrade rules (303 → GET; 307/308
// preserve method+body) collapse to "always GET" — we just re-issue at the
// new URL with the same UA. If this ever grows POST support, add downgrade
// handling here.
async function fetchWithRedirects(url: URL, userAgent: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const response = await doFetch(current, userAgent);
    if (!isRedirect(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response; // 3xx with no Location — let caller handle.
    // Discard the redirect body (without draining) to free the connection.
    try { await response.body?.cancel(); } catch { /* already closed */ }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error(`Invalid redirect Location: ${location}`);
    }
    // Re-run the full URL guard on every hop. Throws on blocked target.
    // Note: re-stringifies a URL we just parsed so validateUrl can re-parse it.
    // Cheap today (pure parsing + regex, no DNS); revisit if validateUrl ever
    // grows expensive checks.
    current = validateUrl(next.toString());
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
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

  // If the first attempt throws (e.g. SSRF guard tripped on a redirect),
  // we deliberately do NOT fall through to the CF UA-swap retry — blocked
  // is blocked, regardless of UA. The retry only fires when the first call
  // returned a Response that looks like a CF challenge.
  let response = await fetchWithRedirects(url, BROWSER_UA);

  if (await isCloudflareChallenge(response)) {
    response = await fetchWithRedirects(url, OPENCODE_UA);
    if (await isCloudflareChallenge(response)) {
      throw new Error("Site requires JS, cannot fetch in shell-only mode (Cloudflare challenge)");
    }
  }

  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const cl = response.headers.get("content-length");
  if (cl && Number(cl) > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Response too large (${(Number(cl) / 1024 / 1024).toFixed(1)} MB, max ${MAX_RESPONSE_MB})`,
    );
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
  // Content-extraction pre-pass: strip page chrome (nav/sidebar/footer/cookie
  // banners/etc.) before pandoc/w3m. extractContent returns null when no
  // extractor is on $PATH, the extractor failed, or it timed out — in all of
  // those cases we fall back to the full HTML so the tool still produces
  // output (the extractor is an optimization, not a contract).
  //
  // Skip the extractor on small bodies (RSS items, API HTML, error pages):
  // the chrome-stripping win doesn't justify the spawn overhead. Then, if the
  // extractor returned <1% of input, assume it picked the wrong container
  // (e.g. a footer on a page with no <article>) and fall back to full HTML.
  // Catches Readability false-negative modes 1 (empty) and 2 (trivial); does
  // not catch modes 3 (wrong-but-substantial) or 4 (stripped tables/code) —
  // unfixable without semantic analysis.
  //
  // body.length is JS string length (UTF-16 code units), not bytes. Both
  // sides of the ratio compare in the same unit, so the guard itself is
  // correct; the 10 KB threshold is fuzzy for non-ASCII pages but doesn't
  // need to be tight. An extractor that returns literally "" passes the
  // null-check and then 0 < 100, so it correctly falls back.
  const extracted = body.length < 10_000 ? null : await extractContent(body, input.url);
  const useExtracted = extracted !== null && extracted.length >= 0.01 * body.length;
  const md = await htmlToMarkdown(useExtracted ? extracted : body);
  return truncate(md, maxChars);
}

export const webfetchTool = defineTool({
  name: "webfetch",
  label: "Web Fetch",
  description:
    "Fetch a URL and return its main text content as markdown. HTML is converted via pandoc or w3m. If `trafilatura` or `rdrview` is on $PATH, runs a Reader-View-style extraction pre-pass to strip page chrome (nav/sidebar/footer), typically shrinking output 5–20× on chrome-heavy pages. Falls back transparently to the full page if no extractor is installed or extraction looks wrong. Use after `websearch` to read full content of a result, or directly when user gives you a URL. Cannot fetch binary content (PDF, images). Cannot reach localhost or RFC1918 link-local addresses.",
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
