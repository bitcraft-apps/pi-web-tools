import type { RequestInit as UndiciRequestInit } from "undici";
import { validateUrl } from "./lib/url-guard.js";
import { getSsrfAgent } from "./lib/ssrf-agent.js";
import { htmlToMarkdown } from "./lib/html2md.js";
import { extractContent } from "./lib/extract.js";
import { findAlternates, ALLOWED_ALTERNATE_TYPES } from "./lib/alternates.js";
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
  /**
   * Character offset into the extracted markdown. Default 0. Used to
   * page through documents whose extracted size exceeds
   * MAX_CHARS_HARD_CAP. The next-offset value is reported in the
   * truncation footer; callers thread it back here on the next call.
   * See issue #132.
   */
  offset?: number;
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

// Slice the extracted markdown for the LLM. Pagination via `offset` is the
// only way to reach content past MAX_CHARS_HARD_CAP — see issue #132. The
// footer is the sole signaling channel: when more remains, it names the
// exact next offset; when the slice reaches end-of-document, no footer is
// appended; when offset overshoots the document, a self-correcting marker
// is returned in lieu of an error so the model can recover.
//
// Exported for unit tests and so callers building paginated workflows can
// reason about the shape directly. Pre-condition: maxChars >= 1, offset >= 0
// — fetchAsMarkdown enforces both before calling.
export function paginate(text: string, offset: number, maxChars: number): string {
  const total = text.length;
  if (offset >= total) {
    // Past-end is reachable via legitimate "next chunk" requests near the
    // tail; throwing would force the caller to add boundary-detection
    // logic for a value we know unambiguously. A self-describing marker
    // with the recovery hint is better UX than an exception.
    return `[OFFSET ${offset} PAST END — document is ${total} chars total. Re-call with offset=0 or omit offset to read from the start.]`;
  }
  const end = Math.min(offset + maxChars, total);
  const slice = text.slice(offset, end);
  if (end >= total) return slice; // last chunk — no footer
  return (
    slice +
    `\n\n[TRUNCATED — returned chars ${offset}..${end} of ${total} total. Re-call with offset=${end} to read the next chunk.]`
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
// `requireSameOriginAs`, when set, additionally enforces that every post-redirect
// URL stays within the given origin — used by the alternate-link fallback so
// a same-origin alternate can't 302 to an attacker origin (validateUrl alone
// blocks private IPs, not arbitrary public hosts).
//
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
async function fetchWithRedirects(
  url: URL,
  userAgent: string,
  requireSameOriginAs?: string,
): Promise<{ response: Response; finalUrl: URL }> {
  let current = url;
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const response = await doFetch(current, userAgent);
    // Both branches below return `current` as `finalUrl`: it's the URL we
    // issued this hop against, and therefore the URL of the response we're
    // handing back to the caller ("where the bytes came from"). Callers
    // treat it as the page URL for same-origin checks and relative-href
    // resolution. We can't rely on Response.url here: with
    // `redirect: "manual"`, undici sets it to the URL of the underlying
    // fetch call, which is correct hop-by-hop but only happens to equal
    // the final URL because we re-issue manually. Returning `current`
    // makes the contract explicit and survives any future change to that
    // undici detail.
    if (!isRedirect(response.status)) return { response, finalUrl: current };
    const location = response.headers.get("location");
    // 3xx with no Location: response is malformed but real (some misconfigured
    // origins do this on 304-without-cache-validators). Hand it back with the
    // URL we issued against as finalUrl — same contract as the non-redirect
    // branch above.
    if (!location) return { response, finalUrl: current };
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
    if (requireSameOriginAs !== undefined && current.origin !== requireSameOriginAs) {
      throw new Error(
        `Cross-origin redirect from ${requireSameOriginAs} to ${current.origin} blocked`,
      );
    }
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

// JS-only SPA shell detection (issue #129).
//
// Pages that are pure JavaScript SPAs return an HTML shell whose visible body
// text is essentially "you need JavaScript to view this site." Without a
// headless browser we have no real content to give the caller; returning the
// shell wastes the max_chars budget and gives the LLM noise instead of an
// actionable error. Mirrors the Cloudflare-challenge path: same error-message
// shape ("Site requires JS, cannot fetch in shell-only mode (...)"), so users
// and the model learn one mental model with two parenthetical sub-causes.
//
// Conservative phrase list — high precision, expanded only per real reproducer,
// never speculatively. Add new markers the same way #127 added base64 strip
// rules: from a measured failing URL.
const JS_SHELL_MARKERS = [
  /\bJavaScript is not available\b/i,
  // "please enable JavaScript" alone is too loose — appears verbatim in many
  // <noscript> fragments that survive extraction on legit pages. Require a
  // "to (continue|use|view|run|access)" tail within ~40 chars so the marker
  // only fires on the imperative-instruction shape SPA shells use. The 40-char
  // window covers Twitter/X's "Please enable JavaScript and Cookies to continue"
  // without re-admitting the bare phrase. `[^.\n]` (not just `[^.]`) so the
  // window can't span a paragraph break — html2md output frequently inserts
  // newlines/emphasis between phrase fragments, and a tail-window crossing
  // unrelated paragraphs would re-admit false positives the period-stop was
  // meant to exclude.
  /\bplease enable JavaScript\b[^.\n\r]{0,40}\bto (continue|use|view|run|access)\b/i,
  /\byou need to enable JavaScript to run this app\b/i,
  /\bthis website requires JavaScript\b/i,
];

// Marker presence anywhere in `text`. Caller pairs this with a hard
// post-extraction size check (< 2 KB) — both conditions together are the
// SPA-shell signature; either alone false-positives. Exported for unit tests.
//
// No prefix-window slice (unlike CF sniffing): the AND gate's size cap is
// already < 2 KB, so a deep-body false positive is structurally impossible
// through fetchAsMarkdown. A separate sniff window would only matter for
// direct callers passing arbitrarily large inputs — none exist in-repo, and
// adding the slice "just in case" was unreachable code that lived only in a
// unit test bypassing the AND.
export function looksLikeJsShell(text: string): boolean {
  return JS_SHELL_MARKERS.some((re) => re.test(text));
}

// Two-condition AND threshold for the shell check, in JS string code units
// (compared against `md.length`). Tuned against the repro in issue #129: a
// Twitter SPA shell post-#127 (data: URI strip) is ~2 KB of "enable
// JavaScript" boilerplate; legitimate extracted articles are many KB even
// when stubby. Lives next to looksLikeJsShell so any future retune touches
// both signals together.
const JS_SHELL_MAX_CHARS = 2048;

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
//
// Returns `{response, finalUrl}` (not just response) because the retry walks
// redirects from the original URL, and the post-retry chain may legitimately
// land on a different origin than the pre-retry one (e.g. server flips from
// a localized interstitial to the canonical host on the second attempt). The
// caller MUST replace its existing `finalUrl` with this one — otherwise the
// extractor and alternate-link path would do same-origin and relative-href
// math against the stale pre-retry origin.
async function maybeRetryAfter(
  response: Response,
  url: URL,
  ua: string,
): Promise<{ response: Response; finalUrl: URL } | null> {
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
  // Hand back finalUrl too — see function comment for why the caller must
  // refresh its own `finalUrl` from this. The retry intentionally re-walks
  // redirects from the original URL, so the post-retry chain can land on a
  // different final URL than the pre-retry one.
  return await fetchWithRedirects(url, ua);
}

export async function fetchAsMarkdown(input: FetchInput): Promise<string> {
  const url = validateUrl(input.url);
  const maxChars = Math.min(Math.max(1, input.max_chars ?? MAX_CHARS_DEFAULT), MAX_CHARS_HARD_CAP);
  // Defensive cap (issue #132): the extracted markdown can never exceed
  // MAX_RESPONSE_BYTES (5 MB → at most 5,242,880 JS string units, since
  // one wire byte yields ≤1 UTF-16 unit after decode + extraction). Any
  // offset beyond that is structurally past-end no matter what URL is
  // fetched — reject up front so a pathological offset=2^53 can't
  // allocate or motivate an unbounded slice.
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid offset: ${offset} (must be a non-negative integer)`);
  }
  if (offset > MAX_RESPONSE_BYTES) {
    throw new Error(
      `offset ${offset} exceeds maximum (${MAX_RESPONSE_BYTES}); the extracted markdown can never be longer than the network cap`,
    );
  }

  // If the first attempt throws (e.g. SSRF guard tripped on a redirect),
  // we deliberately do NOT fall through to the CF UA-swap retry — blocked
  // is blocked, regardless of UA. The retry only fires when the first call
  // returned a Response that looks like a CF challenge.
  let currentUa = BROWSER_UA;
  let { response, finalUrl } = await fetchWithRedirects(url, currentUa);

  if (await isCloudflareChallenge(response)) {
    currentUa = OPENCODE_UA;
    ({ response, finalUrl } = await fetchWithRedirects(url, currentUa));
    if (await isCloudflareChallenge(response)) {
      // Error-string contract: the parenthetical ("Cloudflare challenge" vs
      // "JS-only shell") is the only discriminator between the two shell-mode
      // refusal causes. Callers that need to branch on cause must substring-
      // match the parenthetical. Keep the shape stable across both throw
      // sites; if a third cause is ever added, promote to a structured error
      // (e.g. an `code` field) rather than inventing a third parenthetical.
      throw new Error("Site requires JS, cannot fetch in shell-only mode (Cloudflare challenge)");
    }
  }

  // Refresh finalUrl from the retry: a post-retry redirect chain may land
  // on a different origin than the pre-retry one (see maybeRetryAfter). If
  // we kept the stale finalUrl, the extractor below and tryFollowAlternate
  // would resolve relative hrefs and do same-origin checks against the
  // wrong page URL.
  const retried = await maybeRetryAfter(response, url, currentUa);
  if (retried !== null) ({ response, finalUrl } = retried);

  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const cl = response.headers.get("content-length");
  // `Number.isFinite` guard: `Number("abc")` is NaN and any NaN comparison
  // is false, so a garbage Content-Length would slip past this pre-check.
  // readBoundedBody re-enforces the cap from the stream regardless, but
  // the pre-check exists precisely to short-circuit before reading.
  const clNum = cl ? Number(cl) : NaN;
  if (Number.isFinite(clNum) && clNum > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Response too large (${(clNum / 1024 / 1024).toFixed(1)} MB, max ${MAX_RESPONSE_MB})`,
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
    return paginate(text, offset, maxChars);
  }

  const body = await decodeBody(response, kind);

  if (kind === "json") {
    try {
      const pretty = JSON.stringify(JSON.parse(body), null, 2);
      return paginate("```json\n" + pretty + "\n```", offset, maxChars);
    } catch {
      return paginate(body, offset, maxChars);
    }
  }

  if (kind === "text") {
    return paginate(body, offset, maxChars);
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
  //
  // Use `finalUrl` (post-redirect), not `input.url`: relative hrefs and
  // base-URL resolution inside the extractor must reflect where the bytes
  // actually came from. example.com → www.example.com would otherwise
  // resolve `/foo` against the wrong host.
  const extracted = body.length < 10_000 ? null : await extractContent(body, finalUrl.toString());
  const useExtracted = extracted !== null && extracted.length >= 0.01 * body.length;

  // Thin-extraction fallback (issue #128). Fires only when the extractor
  // *actually ran and returned thin output* — `extracted !== null` rules
  // out both "body too small to bother" and "no extractor on $PATH /
  // extractor failed" (extractContent returns null in both). Without that
  // gate, every fetch on an extractor-less host would pay the alt-scan
  // and a potential extra HTTP round-trip — contradicting the cost-control
  // contract documented in the README.
  //
  // "Thin" = the same condition that already disqualifies the extractor
  // output for the main pipeline (`!useExtracted`, i.e. < 1% of body),
  // plus a hard 200-char floor so a 10-20 KB page with a borderline-1%
  // extraction still qualifies. Above 20 KB, 1% already implies > 200.
  //
  // The HEAD-scan itself (regex tokenization) is cheap; the HTTP round-
  // trip only fires when an allowlisted alternate is actually present —
  // typically YouTube/Vimeo/Substack/etc.
  // `&&` (not `||`) on the 200-char floor: a genuinely short page (e.g.
  // 10 KB body, 150-char correct extraction at 1.5%) passes the 1% check
  // (`useExtracted` is true) and must keep its real content. Only when
  // extraction was already rejected (`!useExtracted`, i.e. < 1% of body)
  // do we apply the additional floor — for very large bodies a passing 1%
  // implies > 200 already, so the floor is a no-op there; it only matters
  // in the 10–20 KB band where 1% can be in the tens of chars.
  const looksThin = extracted !== null && !useExtracted && extracted.length < 200;
  if (looksThin) {
    // Same finalUrl rationale as above: alternate hrefs are resolved and
    // same-origin-checked against the page we actually fetched, not the
    // pre-redirect input.
    const alt = await tryFollowAlternate(body, finalUrl, currentUa);
    if (alt !== null) return paginate(alt, offset, maxChars);
  }

  const md = await htmlToMarkdown(useExtracted ? extracted : body);

  // Issue #129: SPA-shell detection runs *after* extraction + html2md, not
  // against the raw body. A real article fetched via trafilatura is many KB;
  // an SPA shell is a few hundred bytes of "enable JS" text plus chrome that
  // the extractor strips. Post-extraction size is the discriminating signal,
  // and it relies on #127's data: URI strip — without it, a Twitter shell is
  // ~9 KB pre-strip and would slip past the 2 KB ceiling.
  //
  // No UA-swap retry like the CF path: this is a property of the page (no
  // server-rendered content for any UA), not of the request fingerprint.
  //
  // Order matters: cheap `md.length` check first so the regex scan is skipped
  // for the common case of real articles (md ≥ 2 KB). Don't flip — a future
  // refactor that runs the regex on every fetch pays the cost on the happy
  // path for nothing.
  //
  // Fallback to raw `body` when the marker isn't in `md`: trafilatura can
  // strip <noscript> fragments entirely, leaving an extracted-then-html2md
  // output that's near-empty and marker-free even though the upstream HTML is
  // a textbook SPA shell. Without this, the caller would receive a tiny
  // blank-ish string instead of the actionable JS-only shell error.
  //
  // <noscript> blocks are stripped before the body scan: every CRA/Next
  // default template ships <noscript>You need to enable JavaScript to run
  // this app</noscript>, and a page whose extraction merely degenerated
  // (md < 2 KB but real content exists in the live DOM) would otherwise be
  // replaced by the actionable error. Stripping <noscript> means only shells
  // whose *visible* DOM carries the marker trip the fallback — which is the
  // signature we actually want to catch.
  const bodyVisible = body.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, "");
  if (md.length < JS_SHELL_MAX_CHARS && (looksLikeJsShell(md) || looksLikeJsShell(bodyVisible))) {
    throw new Error("Site requires JS, cannot fetch in shell-only mode (JS-only shell)");
  }

  return paginate(md, offset, maxChars);
}

// Try to follow the first allowlisted, same-origin <link rel="alternate">
// in `html` and return its formatted body, or null on any failure.
//
// Same-origin only: a page can advertise an alternate pointing anywhere
// (`<link rel="alternate" href="https://attacker.example/...">`); following
// cross-origin alternates would turn webfetch into an open redirector for
// the page author. The SSRF guard alone isn't sufficient — public-IP
// attackers aren't blocked by it. Same-origin is the natural trust boundary
// for "alternate representation of *this* page."
//
// First match wins: if the first eligible alternate fails (HTTP error,
// network failure, oversized body, unknown content type), we don't try the
// next one — caller falls back to the thin extraction we already had.
// Multi-attempt logic is latency we don't want on the unhappy path.
//
// Pre-HTTP filters (allowlist miss, bad URL, cross-origin) `continue` to
// the next entry instead — see the asymmetry note inside the function.
//
// All HTTP goes through `fetchWithRedirects` so SSRF guard, redirect cap,
// and Retry-After all apply uniformly with the primary fetch.
async function tryFollowAlternate(html: string, pageUrl: URL, ua: string): Promise<string | null> {
  // pageUrl arrives as a URL object (not a string) so we don't re-parse
  // here just to call `.origin` and pass to `new URL(href, base)`. The
  // URL constructor accepts a URL as its base argument directly.
  const pageOrigin = pageUrl.origin;
  // Asymmetry note: pre-HTTP filters — allowlist miss, malformed/SSRF-
  // rejected URL, cross-origin href — use `continue` (skip this entry, try
  // the next). Post-HTTP failures — network error, 4xx/5xx, unparseable
  // body — use first-match-wins (`return null` and let the caller fall
  // back to thin extraction). Pre-HTTP cases aren't "attempts" — we never
  // issued a request — so skipping them to reach the next candidate
  // doesn't violate the no-multi-attempt latency contract.
  for (const alt of findAlternates(html)) {
    if (!ALLOWED_ALTERNATE_TYPES.has(alt.type)) continue;
    let altUrl: URL;
    try {
      // `new URL(href, base)` resolves relative refs against the page URL;
      // `validateUrl` re-applies the SSRF + scheme + blocked-host guard,
      // so an alternate pointing at 169.254.169.254 (AWS IMDS) or
      // 10.0.0.1 still gets rejected here, not just at fetch time.
      altUrl = validateUrl(new URL(alt.url, pageUrl).toString());
    } catch {
      continue;
    }
    // Same-origin filter — see function-level comment for rationale. The
    // post-redirect re-check happens inside fetchWithRedirects via
    // requireSameOriginAs; without it, a same-origin alternate that 302s
    // to an attacker origin would be followed.
    if (altUrl.origin !== pageOrigin) continue;

    let altResponse: Response;
    try {
      // Discard finalUrl on the alternate path: alternates are leaf
      // fetches — we format the body and return, no further URL math
      // depends on where the alternate ultimately landed.
      ({ response: altResponse } = await fetchWithRedirects(altUrl, ua, pageOrigin));
    } catch {
      // Network failure / SSRF on a redirect / too-many-redirects: first
      // match wins, so we surrender and let the caller use the thin
      // extraction. Don't try the next alternate.
      return null;
    }
    if (altResponse.status >= 400) {
      try {
        await altResponse.body?.cancel();
      } catch {
        /* already closed */
      }
      return null;
    }
    return await formatAlternateBody(altResponse);
  }
  return null;
}

// Decode + format an alternate response body. Mirrors the JSON/text branches
// of `fetchAsMarkdown` (no truncation — caller applies max_chars), but skips
// the HTML pipeline: none of the allowlisted alternate types are HTML, and
// pulling extractor + pandoc into the alternate path would mean recursive
// fallbacks. PDF and binary types are also rejected here for the same reason
// — an alternate that claimed `application/json+oembed` and served PDF is
// either misbehaving or hostile; bail out and let the caller fall back.
async function formatAlternateBody(response: Response): Promise<string | null> {
  // Cancel the body on every early return so an unwanted alternate (e.g.
  // application/pdf served against an oEmbed-typed link) doesn't leak the
  // socket. Mirrors the 4xx branch in tryFollowAlternate.
  const cancel = async (): Promise<void> => {
    try {
      await response.body?.cancel();
    } catch {
      /* already closed */
    }
  };

  const ct = response.headers.get("content-type") ?? "";
  const kind = classifyMime(ct);
  if (kind !== "json" && kind !== "text") {
    await cancel();
    return null;
  }

  // Mirror fetchAsMarkdown's content-length pre-check so an alternate
  // server can't bypass the 5 MB cap by virtue of being a fallback path.
  // readBoundedBody enforces the same cap from the stream regardless.
  // `Number.isFinite` guard: see the equivalent comment in fetchAsMarkdown.
  const cl = response.headers.get("content-length");
  const clNum = cl ? Number(cl) : NaN;
  if (Number.isFinite(clNum) && clNum > MAX_RESPONSE_BYTES) {
    // Surface the rejection: an oversize alternate is a deliberate skip,
    // not a bug, but a debugging operator who sees thin extraction returned
    // for a page that *does* advertise an alternate has no way to tell why
    // without this line. Mirrors the over-cap Retry-After warn above.
    console.warn(
      `webfetch: ignoring oversize alternate (${(clNum / 1024 / 1024).toFixed(1)} MB, max ${MAX_RESPONSE_MB}); falling back to thin extraction`,
    );
    await cancel();
    return null;
  }

  let body: string;
  try {
    body = await decodeBody(response, kind);
  } catch {
    // Oversize stream / decode failure: treat as alternate-not-usable and
    // let the caller fall back to the thin extraction. decodeBody may have
    // already consumed/cancelled the body, but cancel() on a closed body
    // is a no-op (caught above).
    await cancel();
    return null;
  }

  if (kind === "json") {
    try {
      const pretty = JSON.stringify(JSON.parse(body), null, 2);
      return "```json\n" + pretty + "\n```";
    } catch {
      // Server lied about content-type or returned malformed JSON. Returning
      // the raw body is still strictly better than the thin extraction we'd
      // otherwise return — oEmbed XML, for instance, will land here.
      return body;
    }
  }
  // text/markdown is already markdown — no fence wrapper, unlike the JSON
  // branch above. Caller can't distinguish this from a text/* fallthrough
  // by output shape, but that's fine: both are intentionally returned raw.
  return body;
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
