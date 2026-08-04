import { type Response as UndiciResponse } from "undici";
import { validateUrl } from "./url-guard.js";
import { htmlToMarkdown } from "./html2md.js";
import { extractContent } from "./extract.js";
import { findAlternates, ALLOWED_ALTERNATE_TYPES } from "./alternates.js";
import { pdfToText } from "./pdf.js";
import { paginate } from "./paginate.js";
import {
  classifyMime,
  decodeBody,
  fetchWithRedirects,
  isCloudflareChallenge,
  maybeRetryAfter,
  MAX_RESPONSE_MB,
  readBoundedBody,
} from "./http.js";
import {
  BROWSER_UA,
  MAX_CHARS_DEFAULT,
  MAX_CHARS_HARD_CAP,
  MAX_RESPONSE_BYTES,
  OPENCODE_UA,
} from "./headers.js";

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

// JS-only SPA shell detection (issue #129).
//
// Pages that are pure JavaScript SPAs return an HTML shell whose visible body
// text is essentially "you need JavaScript to view this site." Without a
// headless browser we have no real content to give the caller; returning the
// shell wastes the max_chars budget and gives the LLM noise instead of an
// actionable error. Mirrors the Cloudflare-challenge path: same error-message
// shape ("Site requires JS, cannot fetch in shell-only mode (...)"), so users
// and the model learn one mental model with two sub-causes. Both refusals are
// `ShellModeError`s; programmatic callers tell them apart via `code`.
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

export type ShellModeCode = "cf_challenge" | "js_shell";

// Message text is owned by the class, keyed by code, so the two throw sites
// cannot drift apart and the parenthetical stays a rendering detail rather
// than the discriminator. Callers branch on `err.code`.
const SHELL_MODE_MESSAGES: Record<ShellModeCode, string> = {
  cf_challenge: "Site requires JS, cannot fetch in shell-only mode (Cloudflare challenge)",
  js_shell: "Site requires JS, cannot fetch in shell-only mode (JS-only shell)",
};

// Shell-only refusal: the page cannot be fetched without executing JS. The
// constructor takes only the code so a wrong code/message pairing is
// unrepresentable. See issue #209.
export class ShellModeError extends Error {
  readonly code: ShellModeCode;

  constructor(code: ShellModeCode) {
    super(SHELL_MODE_MESSAGES[code]);
    this.name = "ShellModeError";
    this.code = code;
  }
}

/**
 * Continuation memo for paginated reads. See
 * [ADR 0001](../../docs/adr/0001-webfetch-pagination-memo.md) and issue #259.
 *
 * The entry holds the exact string that the last successful `offset === 0` call
 * passed to `paginate`. A call with `offset > 0` for the same URL paginates that
 * string and makes no network request, which turns a paginated read from
 * quadratic to linear. The largest gain is the PDF path, which re-ran
 * `pdftotext` on the whole file for every chunk.
 *
 * Properties, all of them load-bearing:
 *
 * - **Key: the validated input URL.** The lookup runs before any request, so the
 *   final URL after redirects is not yet known.
 * - **Value: the exact string that reached `paginate`.** The string includes the
 *   cross-host redirect notice. The agent measured its offsets against that same
 *   string, so a value without the notice would shift every offset.
 * - **One entry.** A successful `offset === 0` call for a different URL replaces
 *   it.
 * - **Write on success only.** A call that throws leaves the entry in place.
 * - No validator, no expiry time, and no persistence. The ADR rejects all three.
 *
 * A stale value is acceptable. A call with `offset === 0` always reaches the
 * network, so no first read comes from memory. A continuation read wants the
 * rest of the document that it already started to read, so the stored snapshot
 * is the correct answer even when the source changed.
 */
let continuationMemo: { key: string; text: string } | null = null;

/** Test-only: drop the continuation memo entry. */
export function __resetFetchMemoForTesting(): void {
  continuationMemo = null;
}

export async function fetchAsMarkdown(input: FetchInput): Promise<string> {
  const url = validateUrl(input.url);
  // The floor of 2 is stated twice: `minimum: 2` on webfetch's `max_chars`
  // (#248) tells the model, and this clamp holds the line for everyone the
  // schema cannot reach — direct `fetchAsMarkdown` callers, and providers
  // that only constrain sampling on a best-effort basis. It is what makes
  // paginate's end-side surrogate-snap asymmetry a true invariant: at
  // maxChars=1 the snap would empty the slice and the half-open tiling would
  // desync. See `paginate` in lib/paginate.ts and the `max_chars` schema field
  // for the full rationale.
  const maxChars = Math.min(Math.max(2, input.max_chars ?? MAX_CHARS_DEFAULT), MAX_CHARS_HARD_CAP);
  // Defensive cap (issue #132): the extracted markdown can never exceed
  // MAX_RESPONSE_BYTES (5 MB). The cap compares JS string units against a
  // byte budget; this is a deliberately loose upper bound, not a tight
  // invariant. Pandoc/trafilatura can grow output (list bullets, escaped
  // chars, repeated extracted headings), so the post-extraction string
  // length is not strictly ≤ wire-byte count — but it stays well under
  // any offset that would survive the response-size cap below. The point
  // here is just to reject pathological offsets (e.g. 2^53) up front so
  // they can't allocate or motivate an unbounded slice; an exact bound
  // would buy nothing.
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid offset: ${offset} (must be a non-negative integer)`);
  }
  // `>=`, not `>`: offset === MAX_RESPONSE_BYTES is guaranteed-past-end
  // (total <= MAX_RESPONSE_BYTES by the response-size cap), so the
  // request would always return the past-end marker — a no-op offset.
  // Backstop for the schema's `maximum: MAX_RESPONSE_BYTES - 1` (#248), which
  // is the same bound one layer out. This throw is what a caller hits when the
  // schema was not applied: a direct import, or a provider that treats the
  // constraint as advisory.
  if (offset >= MAX_RESPONSE_BYTES) {
    throw new Error(
      `offset ${offset} exceeds the maximum addressable range (${MAX_RESPONSE_BYTES} = MAX_RESPONSE_BYTES); documents that large are not supported`,
    );
  }

  // Continuation memo (issue #259). Read it only for `offset > 0`, and only
  // before the first request — see the JSDoc on `continuationMemo`. A miss
  // falls through to a full fetch, which is what keeps the mid-pagination
  // guards reachable: the past-end marker in `paginate`, and the
  // `offset === 0` clause in the JSON fence gate below.
  const memoKey = url.toString();
  if (offset > 0 && continuationMemo?.key === memoKey) {
    return paginate(continuationMemo.text, offset, maxChars);
  }
  // Single exit point for every branch that paginates. The memo must hold the
  // exact string that `paginate` received, and only on success; one helper
  // makes both true by construction. A branch that throws never gets here.
  const finish = (text: string): string => {
    if (offset === 0) continuationMemo = { key: memoKey, text };
    return paginate(text, offset, maxChars);
  };

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
      // Error contract: `ShellModeError.code` is the discriminator between the
      // two shell-mode refusal causes — callers branch on it, never on the
      // message. The message text is a stable model-facing string; changing it
      // changes tool output. A third cause means a new `ShellModeCode` member
      // plus its entry in SHELL_MODE_MESSAGES, not a new parenthetical.
      throw new ShellModeError("cf_challenge");
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

  // Cross-host redirect notice (issue #133). When the input host differs
  // from the host the bytes actually came from, prepend a one-line marker
  // so the model knows where the content originated and can re-fetch the
  // redirect target directly on follow-ups. Same channel as the trailing
  // [TRUNCATED — …] footer; in-band marker, not a structured field.
  // See [ADR 0002](../../docs/adr/0002-in-band-markers.md).
  //
  // Compares `URL.host` (host + port if non-default), not `hostname` —
  // example.com:8443 → example.com is a port change worth flagging.
  // Same-host path/query rewrites, HTTP→HTTPS upgrades on the same host,
  // and multi-hop chains that land back on the input host all naturally
  // produce no notice. www-subdomain differences (example.com →
  // www.example.com) DO produce a notice — strict host equality, no
  // public-suffix-list eTLD+1 folding. See issue #133 for the design
  // decisions; do not re-litigate here.
  //
  // Notice is prepended to the source text passed to `paginate`, so the
  // first chunk (offset=0) carries it and subsequent chunks don't —
  // matches the issue's "one in-band notice line is the contract" and
  // keeps the half-open [offset, end) tiling intact. Losing provenance
  // on offset≥1 is acceptable: the agent already saw the notice on the
  // chunk[0] response that produced the offset value it's now passing
  // back, so re-emitting it on every chunk would be redundant noise
  // (and would shift byte offsets across chunks, breaking the tiling).
  // See issue #133 for the full thread.
  // Strip userinfo before echoing the final URL: a redirect to
  // https://user:token@evil.example/ would otherwise leak the credential
  // into the markdown the model then logs. Query/fragment are preserved
  // because they're part of the redirect target the model may want to
  // re-fetch directly.
  let finalUrlForNotice = finalUrl.toString();
  if (finalUrl.username || finalUrl.password) {
    const sanitized = new URL(finalUrl);
    sanitized.username = "";
    sanitized.password = "";
    finalUrlForNotice = sanitized.toString();
  }
  const notice =
    url.host !== finalUrl.host
      ? `[REDIRECTED — input was ${url.protocol}//${url.host}, final URL is ${finalUrlForNotice}]\n\n`
      : "";

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
    return finish(notice + text);
  }

  const body = await decodeBody(response, kind);

  if (kind === "json") {
    try {
      const pretty = JSON.stringify(JSON.parse(body), null, 2);
      const wrapped = "```json\n" + pretty + "\n```";
      // Gate the ```json fences on "fits in one chunk". If we wrapped a
      // body that paginates, chunk[1+] would slice into the body without
      // an opening fence and without a trailing close — silent corruption
      // for any agent that renders fenced markdown. Falling back to the
      // raw pretty-printed body keeps every chunk self-consistent at the
      // cost of losing the language hint on large JSON responses.
      //
      // The gate is per-call. A continuation that hits the memo never
      // reaches this code: it replays the exact string that the gate
      // already chose, so the fence decision is stable for a hit.
      //
      // A memo miss at offset>0 still runs the gate again (issue #259
      // keeps one entry only, so an interleaved fetch of a second URL
      // produces exactly that case). A body that changed size between
      // calls can then wrap at one offset and unwrap at another (in
      // either direction — grew → wrap-then-unwrap, shrank →
      // unwrap-then-wrap). The grow case is benign: the wrapped branch
      // fits in a single chunk and emits no footer, so the agent never
      // re-calls. The shrink case (unwrap at N=0 → wrap at N>0) lands
      // the re-call past the end of the now-smaller wrapped body, which
      // the past-end marker in `paginate` reports honestly — that
      // recovery path is the intended fallback here, same as for any
      // other mid-pagination mutation.
      //
      // Belt-and-braces: also gate on `offset === 0`. Without it, an
      // agent that re-calls with offset>0 against a wrapped body that
      // happens to fit in one chunk would receive a fenceless tail of
      // JSON (`paginate` slices `wrapped[offset:]`, dropping the opening
      // ```json fence). The shrink-case rationale above covers wrapping
      // mismatches across calls, but a fresh re-call with non-zero
      // offset is always wrong here — fall through to the unwrapped
      // branch so every chunk past offset 0 is self-consistent raw JSON.
      //
      // Length gate is on `(notice + wrapped).length` (not `wrapped.length`)
      // because the notice is what gets prepended to the source passed to
      // `paginate`. Don't "simplify" this back to `wrapped.length` — a
      // cross-host redirect to a JSON body just under the cap would then
      // wrap, and the notice would push the first chunk over.
      if (offset === 0 && (notice + wrapped).length <= maxChars) {
        return finish(notice + wrapped);
      }
      return finish(notice + pretty);
    } catch {
      return finish(notice + body);
    }
  }

  if (kind === "text") {
    return finish(notice + body);
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
    if (alt !== null) return finish(notice + alt);
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
    throw new ShellModeError("js_shell");
  }

  return finish(notice + md);
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

    let altResponse: UndiciResponse;
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
async function formatAlternateBody(response: UndiciResponse): Promise<string | null> {
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
