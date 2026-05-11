import type { RequestInit as UndiciRequestInit } from "undici";
import { validateUrl } from "./lib/url-guard.js";
import { getSsrfAgent } from "./lib/ssrf-agent.js";
import { htmlToMarkdown } from "./lib/html2md.js";
import { extractContent } from "./lib/extract.js";
import { pdfToText } from "./lib/pdf.js";
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
import { defineTool, keyHint } from "@mariozechner/pi-coding-agent";
import { ensureText, type FormatterTheme } from "./lib/render.js";

export interface FetchInput {
  url: string;
  max_chars?: number;
}

const HTML_MIMES = ["text/html", "application/xhtml+xml"];
const HTML_SNIFF_BYTES = 1024;

type BodyKind = "html" | "json" | "text" | "pdf";

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
    // Capture group 1 (tag[1], a[1]) always matches when the outer regex matches; `!`
    // keeps fail-loud semantics if that ever stops being true.
    const tagInner = tag[1]!;
    const attrs: Record<string, string> = {};
    for (let a; (a = attrRe.exec(tagInner)) !== null; ) {
      attrs[a[1]!.toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
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

function pickCharset(response: Response, buf: ArrayBuffer, kind: BodyKind): string | undefined {
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
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
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
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  // Hand back a tight slice so decodeBody's TextDecoder doesn't see padding.
  return buf.buffer.slice(0, total);
}

async function decodeBody(response: Response, kind: BodyKind): Promise<string> {
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
  // PDF gets its own kind so fetchAsMarkdown can route it through pdftotext
  // when available, and fall back to the historical "Cannot fetch" binary
  // error when it isn't. Behavior for users who haven't installed poppler
  // is byte-for-byte identical to before.
  if (lower.startsWith("application/pdf")) return "pdf";
  if (
    lower.startsWith("image/") ||
    lower.startsWith("video/") ||
    lower.startsWith("audio/") ||
    lower.startsWith("application/octet-stream")
  )
    return "binary";
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
  // Typed against undici's own RequestInit (which declares `dispatcher`) so a
  // future undici rename of the field surfaces as a type error here instead
  // of a silent runtime no-op. See lib/ssrf-agent.ts for why this dispatcher
  // exists. Tests that replace global.fetch wholesale bypass this dispatcher
  // — the SSRF re-check guarantee only holds when undici's real fetch runs.
  const init = {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "manual" as const,
    headers: { "User-Agent": userAgent, Accept: ACCEPT_HEADER },
    dispatcher: getSsrfAgent(),
  } satisfies UndiciRequestInit;
  // global fetch's lib.dom RequestInit type doesn't know about `dispatcher`,
  // so the assignment is from a wider literal to a narrower DOM type. The
  // extra `dispatcher` property is a runtime-honored undici extension.
  return fetch(url, init);
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
    try {
      await response.body?.cancel();
    } catch {
      /* already closed */
    }
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

// Read up to `max` bytes from the response stream and discard the rest.
// Cancels the reader so the connection is released. Used by the CF
// challenge sniff path — we only need the first ~few KB of HTML to decide,
// and reading a multi-MB 403 body just to throw a moment later is wasteful.
async function readBodyPrefix(response: Response, max: number): Promise<string> {
  // body is null for HEAD/204/205/304 responses; CF challenge sniff only
  // runs on status===403 GETs in practice, but guard anyway.
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = max - total;
      if (remaining <= 0) break;
      const take = Math.min(value.byteLength, remaining);
      chunks.push(take === value.byteLength ? value : value.subarray(0, take));
      total += take;
      if (total >= max) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  // Hard cut at `max` bytes can split a multi-byte UTF-8 sequence at the
  // tail, producing a trailing U+FFFD. Safe here because the only consumer
  // matches ASCII-only markers (see isCloudflareChallenge); revisit if the
  // marker list ever gains non-ASCII tokens.
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

const CF_SNIFF_BYTES = 4096;

// Maximum honored Retry-After wait. Servers can legitimately ask for
// minutes-to-hours waits (planned maintenance, daily quota resets); blocking
// an agent turn that long is worse UX than a clean error. The cap is the
// budget for "polite, fast retry" — anything longer is the caller's problem.
// See issue #121.
export const RETRY_AFTER_MAX_MS = 10_000;

// Parse an RFC 9110 §10.2.3 Retry-After value: either delta-seconds (a
// non-negative integer) or an HTTP-date. Returns the wait in milliseconds,
// or null if the header is missing/malformed/negative. Exported for unit
// tests; do not export-and-reuse without re-reading the cap rationale above.
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;
  // delta-seconds first: pure integer, no sign, no fraction. RFC 9110 says
  // "non-negative decimal integer"; Number() would happily accept "1.5" or
  // "1e3" and we don't want to silently honor those non-conforming values.
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    // Defense against pathological-length headers: Number("9".repeat(309+))
    // returns Infinity. Practical Retry-After values can never trip this,
    // but a well-formed regex match shouldn't produce Infinity * 1000 = NaN.
    if (Number.isFinite(secs)) return secs * 1000;
    return null;
  }
  const date = Date.parse(trimmed);
  // Only honor Date.parse output when the input actually looks like a date.
  // Date.parse is implementation-defined for non-conforming strings: "1.5"
  // resolves to a year-1 epoch on V8, "-3" can be NaN or a negative epoch,
  // etc. HTTP-date per RFC 9110 §5.6.7 always contains a 3-letter day name
  // and ASCII month name, so requiring a letter before trusting Date.parse
  // rejects all the numeric-looking junk that slipped past the integer regex.
  if (Number.isFinite(date) && /[A-Za-z]/.test(trimmed)) return Math.max(0, date - Date.now());
  return null;
}

async function isCloudflareChallenge(response: Response): Promise<boolean> {
  if (response.headers.get("cf-mitigated") === "challenge") return true;
  if (response.status !== 403) return false;
  // Bounded prefix read instead of clone().text(): a multi-MB 403 used to
  // trigger a full-body buffered read just to throw afterwards. The CF
  // markers we look for are always in the first <2 KB of the challenge
  // page; 4 KB is generous headroom. Tradeoff: a CF challenge whose markers
  // sit past byte 4096 is misclassified as non-CF — acceptable, those don't
  // exist in the wild.
  //
  // We read the response directly (no clone()) because:
  //   - On match: caller throws away `response` and re-fetches with a new UA
  //     (so the consumed body doesn't matter).
  //   - On no-match with status>=400: caller throws without reading body.
  //   - clone() on a streaming body tees the underlying source; one side
  //     blocks until the other drains, so cancelling only the clone can
  //     deadlock when the original is never consumed.
  const prefix = await readBodyPrefix(response, CF_SNIFF_BYTES);
  // ASCII-only markers — required, because `prefix` may have a truncated
  // UTF-8 sequence at the tail (see readBodyPrefix). Do not add non-ASCII
  // alternatives here without switching to a streaming/incremental decoder.
  return /just a moment|cf-chl-bypass/i.test(prefix);
}

// Retry-After honoring for 429 / 503 (issue #121). Exactly one retry,
// bounded by RETRY_AFTER_MAX_MS, only when the server tells us how long
// to wait. Returns the post-retry response, or null if no retry was
// performed (caller keeps the original). The "exactly one retry"
// invariant is structural: this function is called once per fetchAsMarkdown
// turn and never recurses.
//
// We deliberately retry against the *original* URL, not the post-redirect
// final URL: re-walking the redirect chain re-runs validateUrl on every
// hop, so an SSRF-blocked target can't be smuggled in by a server that
// 302s on the first attempt and 429s with a Retry-After on the second.
// Mild cost: an extra round-trip on the (rare) chained-redirect-then-rate-
// limit path. Worth it.
async function maybeRetryAfter(response: Response, url: URL, ua: string): Promise<Response | null> {
  if (response.status !== 429 && response.status !== 503) return null;
  const waitMs = parseRetryAfter(response.headers.get("retry-after"));
  if (waitMs === null) return null;
  if (waitMs > RETRY_AFTER_MAX_MS) {
    // Don't silently swallow an over-cap wait — the user otherwise sees a
    // generic HTTP 429/503 with no hint that a retry was on offer.
    console.warn(
      `webfetch: ignoring Retry-After of ${waitMs}ms (cap ${RETRY_AFTER_MAX_MS}ms); surfacing HTTP ${response.status}`,
    );
    return null;
  }
  // Cancel the first response's body so the connection releases before we
  // sleep — otherwise undici keeps the socket pinned for the entire wait.
  // Realistic failure mode of body.cancel() is "stream is locked" (e.g. if
  // a future caller pre-read it), not "already closed"; the catch covers
  // both. body is non-null for normal 429/503 responses but ?. is cheap
  // belt-and-suspenders.
  try {
    await response.body?.cancel();
  } catch {
    /* locked or already closed — either way, nothing actionable here */
  }
  await new Promise((r) => setTimeout(r, waitMs));
  return fetchWithRedirects(url, ua);
}

export async function fetchAsMarkdown(input: FetchInput): Promise<string> {
  const url = validateUrl(input.url);
  const maxChars = Math.min(Math.max(1, input.max_chars ?? MAX_CHARS_DEFAULT), MAX_CHARS_HARD_CAP);

  // If the first attempt throws (e.g. SSRF guard tripped on a redirect),
  // we deliberately do NOT fall through to the CF UA-swap retry — blocked
  // is blocked, regardless of UA. The retry only fires when the first call
  // returned a Response that looks like a CF challenge.
  let currentUa = BROWSER_UA;
  let response = await fetchWithRedirects(url, currentUa);

  if (await isCloudflareChallenge(response)) {
    currentUa = OPENCODE_UA;
    response = await fetchWithRedirects(url, currentUa);
    if (await isCloudflareChallenge(response)) {
      throw new Error("Site requires JS, cannot fetch in shell-only mode (Cloudflare challenge)");
    }
  }

  response = (await maybeRetryAfter(response, url, currentUa)) ?? response;

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

  if (kind === "pdf") {
    // Read the (already-bounded) response body as bytes and hand it to
    // pdftotext. On null (no pdftotext on $PATH, or it failed/timed out)
    // we throw the historical "Cannot fetch application/pdf" error so
    // the no-poppler case is byte-for-byte identical to pre-#119 behavior.
    // No markdown wrapping on success: PDFs aren't structured for markdown
    // rendering; pretending they are produces worse output than the raw
    // `pdftotext -layout` text.
    const buf = await readBoundedBody(response);
    const text = await pdfToText(buf);
    if (text === null) {
      // kind === "pdf" already implies classifyMime accepted application/pdf,
      // so hardcode it here rather than re-parsing contentType.
      throw new Error(`Cannot fetch application/pdf. Use a tool that supports binary content.`);
    }
    return truncate(text, maxChars);
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

const webfetchSchema = Type.Object({
  url: Type.String({ description: "Absolute http(s) URL to fetch." }),
  max_chars: Type.Optional(
    Type.Number({
      description: `Truncate output at N chars (default ${MAX_CHARS_DEFAULT}, hard cap ${MAX_CHARS_HARD_CAP}).`,
      default: MAX_CHARS_DEFAULT,
    }),
  ),
});

export interface WebfetchToolDetails {
  url: string;
  /** Length of the LLM-facing markdown body in JS string units (not bytes). */
  chars: number;
  /**
   * UTF-8 byte length of the LLM-facing markdown body. Computed once in
   * `execute()` so the renderer is a pure lookup — no Buffer.byteLength on
   * every redraw. Optional because sessions persisted by older versions of
   * this tool didn't carry it; the renderer falls back to recomputing from
   * `body` when missing.
   */
  bytes?: number;
}

export interface WebfetchCallArgs {
  url?: string;
  max_chars?: number;
}

/**
 * Cap on rendered preview lines in the expanded view. Long pages are
 * trimmed with a `… +M more lines (full content was sent to the model)`
 * footer so the row never floods scrollback.
 *
 * 200 is a deliberate compromise: README/docs hit 1k–3k lines; 200 is
 * enough to skim structure (headings, first paragraph) without dwarfing
 * the surrounding chat. Bump if user feedback says "I keep expanding
 * twice"; lower if rows still feel oppressive at 200.
 *
 * Exported for the test that asserts the truncation footer math —
 * tying the test to the constant, not a magic number duplicate.
 */
export const WEBFETCH_PREVIEW_MAX_LINES = 200;

/**
 * Per-line character cap for the expanded preview. Bounds horizontal
 * blast radius the way `WEBFETCH_PREVIEW_MAX_LINES` bounds vertical:
 * a 200-line response where every line is 50KB (minified JSON, single-
 * line HTML that slipped past extraction) would still flood the
 * terminal without this. 500 fits a wide-terminal paragraph and most
 * "one log line per record" outputs; tune if real reports show it
 * cutting useful content. Lines over the cap are sliced with a single
 * … — the model still received the full content, see footer.
 */
export const WEBFETCH_PREVIEW_MAX_LINE_CHARS = 500;

/**
 * Format a byte count using the same B/KB/MB convention as the
 * built-in `read` tool's `formatSize` (see
 * `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/truncate.js`).
 * Inlined rather than imported because that module is not part of the
 * package's public export surface — importing through `dist/...` would
 * couple us to internal layout.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Compact display form of `url` for the collapsed result header:
 * `<host><pathname>`. Strips scheme (always http/https — see url-guard),
 * userinfo, query, and hash. Query is dropped because URLs routinely
 * carry secrets in `?token=...`, `?sig=...`, signed-request params, etc.,
 * and the collapsed header lands in chat scrollback / session exports.
 * The full URL (with query) is still shown in `renderCall` — that's the
 * user/LLM's own input, not derived display. Falls back to the raw
 * string when parsing fails so a malformed URL still renders something
 * recognizable instead of an empty header.
 */
function shortDisplayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Number of lines in `body` for the collapsed-header `~N lines` stat.
 * Empty body → 0 (rather than 1 from a naive split), so an error path
 * that hands an empty body to the formatter doesn't claim "~1 lines".
 */
function countLines(body: string): number {
  if (body.length === 0) return 0;
  return body.split("\n").length;
}

/**
 * Pure formatter for the webfetch tool call header.
 *
 * `max_chars` is shown muted only when the user (LLM) overrode the
 * default — default invocations stay compact. Mirrors
 * `formatWebsearchCall`'s convention.
 *
 * Security note: the URL is shown verbatim (including query string),
 * which mirrors the user/LLM's own input rather than derived display.
 * `shortDisplayUrl` strips `?...` from the *result* header to avoid
 * leaking secrets carried in query params (`?token=`, `?sig=`, signed
 * requests, etc.) into scrollback. The asymmetry is intentional: the
 * call header echoes what the agent already typed, the result header
 * is a new surface where redaction is cheap. Don't "fix" one to match
 * the other without re-reading both notes.
 */
export function formatWebfetchCall(
  args: WebfetchCallArgs | undefined,
  theme: FormatterTheme,
): string {
  const url = typeof args?.url === "string" ? args.url : "";
  let text = theme.fg("toolTitle", theme.bold("webfetch"));
  // Only emit the URL segment when we actually have one — otherwise the
  // header ends with a trailing space that's invisible on render but
  // shows up in copy/paste and snapshot diffs.
  if (url) text += " " + theme.fg("accent", url);
  // Show max_chars whenever the LLM explicitly passed a non-default value,
  // including 0 — `execute` will then truncate to 0 and the user needs to
  // see *why* the fetch came back empty. The default-value check keeps
  // headers compact for the common path.
  if (typeof args?.max_chars === "number" && args.max_chars !== MAX_CHARS_DEFAULT) {
    text += " " + theme.fg("muted", `max_chars=${args.max_chars}`);
  }
  return text;
}

export interface FormatWebfetchResultInput {
  details: WebfetchToolDetails | undefined;
  /**
   * The LLM-facing markdown body (i.e. `result.content[0].text`).
   * Source of truth for both the collapsed `~lines` stat and the
   * expanded preview — not mirrored into `details` (see issue #100).
   * On the error path this is the error message, not a body.
   */
  body: string;
  expanded: boolean;
  isError: boolean;
  /** Used as the error message when `isError` is true. */
  errorText?: string;
  /** Pre-rendered "(press X to expand)" hint. Injected so tests don't depend on keybindings. */
  expandHint: string;
}

/**
 * Pure formatter for the webfetch tool result. See issue #100 for the
 * collapsed/expanded/error spec.
 */
export function formatWebfetchResult(
  input: FormatWebfetchResultInput,
  theme: FormatterTheme,
): string {
  const { details, body, expanded, isError, errorText, expandHint } = input;

  if (isError) {
    const msg = errorText && errorText.length > 0 ? errorText : "error";
    return theme.fg("error", `✗ webfetch: ${msg}`);
  }

  const display = details?.url ? shortDisplayUrl(details.url) : "";
  // Byte count is computed once in `execute()` and stashed on `details`
  // (see WebfetchToolDetails.bytes) so this renderer is a pure lookup —
  // no Buffer.byteLength on every redraw. Fall back to recomputing from
  // `body` when `details.bytes` is missing (older persisted sessions, or
  // the error path where there is no `details`). `chars` is deliberately
  // not used here — it's JS string length and undercounts non-ASCII
  // pages by ~half.
  // utf-8 is Buffer.byteLength's default encoding — omitted for clarity.
  const sizeBytes = details?.bytes ?? Buffer.byteLength(body);
  const lineCount = countLines(body);
  // No tilde: `lineCount` is an exact count of newline-separated segments
  // in the body we actually have. `body` may itself be truncated upstream
  // by `max_chars`, but that truncation is already reflected in `body` —
  // the count over what we hold is exact, not approximate.
  const stats = `(${formatSize(sizeBytes)}, ${lineCount} lines)`;
  const headerBody = display ? `✓ fetched ${display} ${stats}` : `✓ fetched ${stats}`;
  const header = theme.fg("success", headerBody);

  if (!expanded) {
    return `${header} (${expandHint})`;
  }

  if (lineCount === 0) return header;

  // Per-line cap: WEBFETCH_PREVIEW_MAX_LINES bounds vertical scrollback,
  // but a 200-line page where each line is 50KB (minified JSON, single-
  // line HTML that slipped past extraction) still floods the terminal
  // horizontally. 500 chars is plenty to skim a wrapped paragraph or a
  // shell-friendly JSON line; longer lines get an ellipsis so the user
  // knows content was elided for *this view*. Full content still went to
  // the model — see footer.
  const capLine = (line: string): string =>
    line.length > WEBFETCH_PREVIEW_MAX_LINE_CHARS
      ? line.slice(0, WEBFETCH_PREVIEW_MAX_LINE_CHARS) + "…"
      : line;
  const rawLines = body.split("\n");
  const lines = rawLines.map(capLine);
  if (lines.length <= WEBFETCH_PREVIEW_MAX_LINES) {
    return `${header}\n${lines.join("\n")}`;
  }
  const preview = lines.slice(0, WEBFETCH_PREVIEW_MAX_LINES).join("\n");
  const remaining = lines.length - WEBFETCH_PREVIEW_MAX_LINES;
  const footer = theme.fg(
    "muted",
    `… +${remaining} more lines (full content was sent to the model)`,
  );
  return `${header}\n${preview}\n${footer}`;
}

export const webfetchTool = defineTool<typeof webfetchSchema, WebfetchToolDetails>({
  name: "webfetch",
  label: "Web Fetch",
  description:
    "Fetch a URL and return its main text content as markdown. HTML is converted via pandoc or w3m. If `trafilatura` or `rdrview` is on $PATH, runs a Reader-View-style extraction pre-pass to strip page chrome (nav/sidebar/footer), typically shrinking output 5–20× on chrome-heavy pages. Falls back transparently to the full page if no extractor is installed or extraction looks wrong. Use after `websearch` to read full content of a result, or directly when user gives you a URL. Cannot fetch binary content (PDF, images). Cannot reach localhost or RFC1918 link-local addresses.",
  parameters: webfetchSchema,
  async execute(_id, params, _signal, _onUpdate, _ctx) {
    const md = await fetchAsMarkdown({ url: params.url, max_chars: params.max_chars });
    return {
      content: [{ type: "text", text: md }],
      details: { url: params.url, chars: md.length, bytes: Buffer.byteLength(md, "utf-8") },
    };
  },

  renderCall(args, theme, context) {
    const text = ensureText(context.lastComponent);
    text.setText(formatWebfetchCall(args, theme));
    return text;
  },

  renderResult(result, options, theme, context) {
    const text = ensureText(context.lastComponent);
    const first = result.content[0];
    const bodyText = first && first.type === "text" ? first.text : "";
    text.setText(
      formatWebfetchResult(
        {
          details: result.details,
          body: bodyText,
          expanded: options.expanded,
          isError: context.isError,
          errorText: context.isError ? bodyText : undefined,
          expandHint: keyHint("app.tools.expand", "to expand"),
        },
        theme,
      ),
    );
    return text;
  },
});
