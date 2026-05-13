// `<link rel="alternate">` discovery for the webfetch thin-extraction fallback.
//
// When the extractor + pandoc/w3m pipeline produces thin output (typically
// because the page is a JS-rendered shell or a localized interstitial), a
// useful clean alternative is often advertised right there in <head> via the
// W3C-standard alternate-link discovery mechanism (oEmbed et al.). Following
// it costs us one HTTP round-trip and yields title/author/description for an
// entire class of sites — without a single line of per-host code.
//
// Allowlist, not blocklist: unknown `type` values are skipped silently. New
// media types are added in follow-up PRs with evidence.
//
// Explicitly excluded:
//   - application/rss+xml, application/atom+xml — feeds OF other content,
//     not alternate representations of the current page.
//   - <link media="...">                       — same shell page in another
//                                                viewport.
//   - android-app:// / ios-app:// hrefs        — not http(s).
//   - <link rel="canonical"> / "amphtml"        — out of scope (see issue #128
//                                                non-goals).
export const ALLOWED_ALTERNATE_TYPES: ReadonlySet<string> = new Set([
  // oEmbed standard JSON form. Highest signal: YouTube, Vimeo, Flickr,
  // SoundCloud, WordPress.com, Substack, Spotify, DeviantArt, Slideshare.
  "application/json+oembed",
  // oEmbed XML form — same providers, less common.
  "application/xml+oembed",
  // Author-served markdown alternate. Rare, but unambiguous when present.
  "text/markdown",
]);

export interface Alternate {
  /** href as written in the link tag — may be absolute or relative. */
  url: string;
  /** type attribute, lowercased and trimmed. */
  type: string;
  /** title attribute if present (some sites use it as a human-readable label). */
  title?: string;
}

// Scope the scan to <head>...</head>. Falls back to "<head>...<body" when
// </head> is missing (malformed but real — see acceptance criteria), and to
// "<head>... end-of-string" when neither closer exists. The acceptance test
// for malformed <head> exercises the fallback.
//
// Without this scope a stray <link rel="alternate"> in <body> (some sites
// inject in-content video embeds with link tags) would be picked up too,
// against the spec — alternate-link discovery is a <head>-only mechanism.
const HEAD_RE = /<head\b[^>]*>([\s\S]*?)(?:<\/head\s*>|<body\b|$)/i;
const LINK_RE = /<link\b([^>]*)>/gi;
// Same attribute tokenizer as the meta-charset sniffer in webfetch.ts —
// see that file for the anti-substring-match rationale. Keep these two
// regexes in sync if either grows attribute-syntax support.
const ATTR_RE = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;

/**
 * Scan the <head> of `html` and return every <link rel="alternate"> with an
 * allowlistable shape (has `type`, has `href`, no `media`, http/https or
 * relative `href`). Type filtering against ALLOWED_ALTERNATE_TYPES happens
 * at the call site so callers can also see denied entries in tests/logs.
 *
 * Order matches document order. First-match-wins is a caller policy.
 *
 * Pure: no I/O, no side effects. Unit-testable without mocks.
 */
export function findAlternates(html: string): Alternate[] {
  const headMatch = HEAD_RE.exec(html);
  if (!headMatch) return [];
  const head = headMatch[1] ?? "";

  // Strip HTML comments first so a commented-out <link> can't leak through.
  // An unterminated <!-- truncates the scan window to be safe — mirrors
  // sniffHtmlMetaCharset's defense.
  let scope = head.replace(/<!--[\s\S]*?-->/g, "");
  const unterm = scope.indexOf("<!--");
  if (unterm !== -1) scope = scope.slice(0, unterm);

  const out: Alternate[] = [];
  // LINK_RE is a /g regex with state; reset before each pass so this
  // function is re-entrant.
  LINK_RE.lastIndex = 0;
  for (let tag; (tag = LINK_RE.exec(scope)) !== null; ) {
    const tagInner = tag[1] ?? "";
    const attrs: Record<string, string> = {};
    ATTR_RE.lastIndex = 0;
    for (let a; (a = ATTR_RE.exec(tagInner)) !== null; ) {
      attrs[a[1]!.toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    }

    // rel may be a token list — "alternate canonical", etc. Tokenize on
    // whitespace and check for a literal "alternate" token; substring match
    // would let "alternateAnything" through.
    const rel = (attrs.rel ?? "").toLowerCase();
    if (!rel.split(/\s+/).filter(Boolean).includes("alternate")) continue;

    // <link media="..."> variants are the same shell page in another
    // viewport (handheld, screen widths) — explicitly excluded by the
    // design. An empty media="" attribute is treated as no media.
    if ((attrs.media ?? "") !== "") continue;

    const href = attrs.href ?? "";
    if (!href) continue;
    // Reject non-http(s) absolute schemes (android-app:, ios-app:,
    // javascript:, mailto:, data:). A relative href has no scheme prefix
    // and passes through; the caller resolves + re-validates against the
    // page URL before fetching.
    const schemeMatch = /^([a-z][a-z0-9+\-.]*):/i.exec(href);
    if (schemeMatch && !/^https?$/i.test(schemeMatch[1]!)) continue;

    const type = (attrs.type ?? "").toLowerCase().trim();
    // No type attribute means "same media type as the current document"
    // per HTML spec — for an HTML page that's text/html, which is never
    // in our allowlist anyway. Drop early to keep the call-site filter
    // honest (an Alternate with type:"" would never satisfy the Set).
    if (!type) continue;

    const entry: Alternate = { url: href, type };
    if (attrs.title) entry.title = attrs.title;
    out.push(entry);
  }
  return out;
}
