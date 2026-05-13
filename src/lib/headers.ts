export const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const OPENCODE_UA = "opencode";

// Prefer markdown when the server supports content negotiation. A growing
// class of high-traffic developer documentation sites (Cloudflare's
// "Markdown for Agents", GitHub docs, Anthropic/Claude docs, Stripe API docs,
// …) honor `Accept: text/markdown` and return clean, pre-rendered markdown,
// often 90–99% smaller than the equivalent HTML page. classifyMime() routes
// any text/* response (markdown, plain) through the verbatim text path, so
// these responses bypass the trafilatura/pandoc pipeline entirely.
//
// HTML stays at q=0.9 — a small q-gap is the standard way to express
// "prefer markdown but happily take HTML" without letting intermediaries
// shuffle order, and it stays high enough that no compliant server downgrades
// to */* when both are available. application/xhtml+xml is dropped to q=0.9
// alongside HTML (down from an implicit q=1.0); XHTML-strict sites serve only
// xhtml so the tie with HTML doesn't matter in practice. Everything else is
// demoted one step (xml 0.9→0.8, */* 0.8→0.7) to keep markdown's lead intact.
// Servers that ignore the preference (the majority today) return HTML
// byte-identical to before.
export const ACCEPT_HEADER =
  "text/markdown,text/html;q=0.9,application/xhtml+xml;q=0.9,application/xml;q=0.8,*/*;q=0.7";

export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_CHARS_DEFAULT = 50_000;
export const MAX_CHARS_HARD_CAP = 200_000;
