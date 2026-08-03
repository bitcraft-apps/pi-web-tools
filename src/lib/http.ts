// HTTP transport policy for webfetch.
//
// This module owns everything between "a validated URL" and "a decoded body":
// redirect walking with an SSRF re-check on every hop, the response-size cap,
// charset selection, the Cloudflare challenge sniff, and Retry-After honoring.
// It hands the caller a `Response` plus the URL the bytes actually came from,
// and knows nothing about extraction, markdown, or pagination.
//
// `BodyKind` and `classifyMime` live here because both layers need them: the
// transport uses the kind to pick a charset, the pipeline uses it to route.

import {
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from "undici";
import { validateUrl } from "./url-guard.js";
import { getSsrfAgent } from "./ssrf-agent.js";
import { ACCEPT_HEADER, FETCH_TIMEOUT_MS, MAX_RESPONSE_BYTES } from "./headers.js";

const HTML_MIMES = ["text/html", "application/xhtml+xml"];
const HTML_SNIFF_BYTES = 1024;

export type BodyKind = "html" | "json" | "text" | "pdf";

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
  for (let tag; (tag = metaRe.exec(text)) !== null;) {
    // Capture group 1 (tag[1], a[1]) always matches when the outer regex matches; `!`
    // keeps fail-loud semantics if that ever stops being true.
    const tagInner = tag[1]!;
    const attrs: Record<string, string> = {};
    for (let a; (a = attrRe.exec(tagInner)) !== null;) {
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

function pickCharset(
  response: UndiciResponse,
  buf: ArrayBuffer,
  kind: BodyKind,
): string | undefined {
  const httpCharset = parseCharset(response.headers.get("content-type") ?? "");
  if (httpCharset) return httpCharset;
  if (kind === "html") return sniffHtmlMetaCharset(buf);
  return undefined;
}

export const MAX_RESPONSE_MB = `${(MAX_RESPONSE_BYTES / 1024 / 1024).toFixed(0)} MB`;

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
export async function readBoundedBody(response: UndiciResponse): Promise<ArrayBuffer> {
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

export async function decodeBody(response: UndiciResponse, kind: BodyKind): Promise<string> {
  const buf = await readBoundedBody(response);
  const charset = pickCharset(response, buf, kind);
  if (charset) {
    const decoded = tryDecode(buf, charset);
    if (decoded !== undefined) return decoded;
    // unknown encoding label — fall through to utf-8
  }
  return new TextDecoder("utf-8").decode(buf);
}

export function classifyMime(ct: string): BodyKind | "binary" {
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

const MAX_REDIRECTS = 5;

// The fetch implementation, resolved through a module-level binding so tests
// can substitute it. Defaults to the *installed* undici's fetch — deliberately
// not Node's global fetch. See lib/ssrf-agent.ts: routing both the fetch and
// the dispatcher through one undici copy is what makes the SSRF connect-time
// hook reliable across Node versions.
let fetchImpl: typeof undiciFetch = undiciFetch;

/**
 * Test-only seam. Replaces the fetch used by `doFetch`; pass `null` to
 * restore the real one. Not part of the public API.
 *
 * This exists because stubbing `global.fetch` no longer intercepts anything:
 * `doFetch` calls undici's fetch directly, so a global stub would let the
 * request escape to the network instead of failing loudly.
 */
export function __setFetchForTesting(fn: typeof undiciFetch | null): void {
  fetchImpl = fn ?? undiciFetch;
}

// Single-hop fetch — does NOT follow redirects. Caller is responsible for
// re-validating Location targets and looping. See fetchWithRedirects.
async function doFetch(url: URL, userAgent: string): Promise<UndiciResponse> {
  // `init` is typed against undici's own RequestInit, which declares
  // `dispatcher`, so a future undici rename surfaces as a type error here
  // rather than a silent runtime no-op. Since we now call undici's fetch
  // directly this is a plain typed argument — no DOM/undici widening needed.
  const init = {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "manual" as const,
    headers: { "User-Agent": userAgent, Accept: ACCEPT_HEADER },
    dispatcher: getSsrfAgent(),
  } satisfies UndiciRequestInit;
  return fetchImpl(url, init);
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
export async function fetchWithRedirects(
  url: URL,
  userAgent: string,
  requireSameOriginAs?: string,
): Promise<{ response: UndiciResponse; finalUrl: URL }> {
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
async function readBodyPrefix(response: UndiciResponse, max: number): Promise<string> {
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

export async function isCloudflareChallenge(response: UndiciResponse): Promise<boolean> {
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
export async function maybeRetryAfter(
  response: UndiciResponse,
  url: URL,
  ua: string,
): Promise<{ response: UndiciResponse; finalUrl: URL } | null> {
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
