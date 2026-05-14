← [README](../README.md) · sibling: [PDF support](pdf.md)

# Content extraction (optional)

For chrome-heavy pages (GitHub repos, MDN, news articles, Stack Overflow, blog posts) the bulk of the converted markdown is navigation, sidebars, footers, cookie banners, and inline icon SVGs — not the content the agent asked for. If a Reader-View-style extractor is on `$PATH`, `webfetch` runs it between the HTTP fetch and the markdown conversion. Result: typically 5–20× smaller output on those pages, with the actual article preserved.

**Install one (recommended):**

```bash
pipx install trafilatura     # works everywhere with Python; recommended primary install
# rdrview alternative — https://github.com/eafer/rdrview
#   Linux: package manager, or build from source.
#   macOS: build from source (no homebrew formula upstream).
```

Detection order: `trafilatura` first, then `rdrview`. Detected once per process and cached. The extractor emits cleaned HTML; the existing `pandoc`/`w3m` step then converts it to markdown so the output style is identical regardless of which extractor (or none) ran.

No extractor present? `webfetch` keeps working — you just get the full pre-extraction markdown as before. A one-shot warning is written to stderr on the first call so you know what you're missing; it is **never** added to tool output.

## Caveats

- **Relative links.** `rdrview` resolves relative `href`s to absolute using the page URL (post-redirect, when the request was redirected — i.e. the host the bytes actually came from, not `input.url`). `trafilatura` (when used via stdin) does not; relative links stay relative in its output. Most agents handle this from context; mention it in your prompt if it matters.
- **Fallback when extraction looks wrong.** If the extracted HTML is < 1% of the original and the original was > 10 KB (e.g. Readability picked the wrong container on a chrome-only page), `webfetch` discards the extracted result and converts the full HTML instead. You'll get a larger but complete result.
- **Pages where the wanted content is outside the article container** (e.g. a code listing in a sidebar) may have it stripped by extraction. There's currently no per-call opt-out; if it bites you in practice, open an issue with the URL.
- **Alternate-link fallback when extraction is thin.** When the extractor + pandoc/w3m pipeline produces nothing useful (extracted < 1% of input *and* < 200 chars), `webfetch` parses the original HTML's `<head>` for a [`<link rel="alternate">`](https://html.spec.whatwg.org/multipage/links.html#rel-alternate) and follows the first allowlisted entry. Allowlisted media types: `application/json+oembed`, `application/xml+oembed`, `text/json+oembed`, `text/xml+oembed`, `text/markdown`. RSS/Atom feeds, `media=`-scoped variants, and `android-app:`/`ios-app:` hrefs are excluded.

  The fallback fires zero extra HTTP round-trips on the 95% of pages that don't ship an alternate; on JS-shell pages that do (YouTube watch pages, Substack posts, Vimeo, SoundCloud, WordPress.com, …) it surfaces oEmbed title/author/description in place of an empty interstitial. First match wins — if the alternate fetch fails, no further alternates are tried.
- **Same-origin only on the alternate fallback.** A page advertising a cross-origin alternate is treated as a potential open-redirector and the link is skipped — `webfetch` falls back to the thin extraction it already had. The check is also re-applied on every redirect hop, so a same-origin alternate that 302s to another origin is rejected too.
- **$PATH trust.** The agent process inherits the user's `$PATH`; bare `trafilatura`/`rdrview` (same posture as `pandoc`/`ddgr`) means a poisoned earlier `$PATH` entry runs as the extractor. Newly relevant here because extractors parse attacker-controlled HTML.
