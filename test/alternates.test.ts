import { describe, it, expect } from "vitest";
import { findAlternates, ALLOWED_ALTERNATE_TYPES } from "../src/lib/alternates.js";

// Acceptance criteria from issue #128:
//   - oEmbed JSON link present
//   - multiple alternates (first-allowed wins — first-match-wins is a caller
//     policy, but we assert document-order preservation here)
//   - media= filtered out
//   - android-app: / ios-app: filtered out
//   - RSS/Atom skipped (filtered at call site via the allowlist; here we
//     just confirm they don't get a special pass through findAlternates)
//   - <link> inside <body> ignored
//   - malformed <head> (no closing tag) handled

const OEMBED_JSON = "application/json+oembed";
const OEMBED_XML = "application/xml+oembed";

const youtubeOembedHref =
  "https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ";

describe("findAlternates", () => {
  it("returns oEmbed JSON link when present", () => {
    const html = `
      <html><head>
        <title>x</title>
        <link rel="alternate" type="${OEMBED_JSON}" href="${youtubeOembedHref}" title="Rick Astley">
      </head><body></body></html>
    `;
    const alts = findAlternates(html);
    expect(alts).toHaveLength(1);
    expect(alts[0]).toEqual({
      url: youtubeOembedHref,
      type: OEMBED_JSON,
      title: "Rick Astley",
    });
  });

  it("preserves document order across multiple alternates", () => {
    // The caller iterates in returned order and stops at the first allowed +
    // same-origin entry. The order here is the contract first-match-wins
    // depends on.
    const html = `
      <head>
        <link rel="alternate" type="application/rss+xml" href="/feed.rss">
        <link rel="alternate" type="${OEMBED_JSON}" href="/oembed.json">
        <link rel="alternate" type="${OEMBED_XML}" href="/oembed.xml">
      </head>
    `;
    const alts = findAlternates(html);
    expect(alts.map((a) => a.type)).toEqual(["application/rss+xml", OEMBED_JSON, OEMBED_XML]);
  });

  it("filters out <link media='...'> variants", () => {
    // A handheld/screen variant is the same shell page in another viewport,
    // not an alternate representation of its content — never a useful
    // fallback, and the spec carve-out keeps "first match" honest.
    const html = `
      <head>
        <link rel="alternate" type="text/html" media="handheld" href="/m/">
        <link rel="alternate" type="${OEMBED_JSON}" href="/oembed.json">
      </head>
    `;
    const alts = findAlternates(html);
    expect(alts).toHaveLength(1);
    expect(alts[0]?.url).toBe("/oembed.json");
  });

  it("filters out android-app: and ios-app: hrefs", () => {
    // Deep-link advertisements, not http(s). The same-origin guard at the
    // call site would also reject these, but rejecting at parse time keeps
    // first-match-wins from being dragged off by a non-fetchable scheme.
    const html = `
      <head>
        <link rel="alternate" href="android-app://com.example/example/x">
        <link rel="alternate" href="ios-app://12345/example/x">
        <link rel="alternate" type="${OEMBED_JSON}" href="/oembed.json">
      </head>
    `;
    const alts = findAlternates(html);
    expect(alts).toHaveLength(1);
    expect(alts[0]?.type).toBe(OEMBED_JSON);
  });

  it("returns RSS/Atom entries (call site applies allowlist)", () => {
    // findAlternates is intentionally type-agnostic: it returns every
    // well-formed <link rel=alternate> with a type, and the caller filters
    // against ALLOWED_ALTERNATE_TYPES. This test pins that contract — the
    // allowlist intersection happens once, in webfetch.ts, so the parser
    // can also surface denied entries to tests/logs without reparsing.
    const html = `
      <head>
        <link rel="alternate" type="application/rss+xml" href="/feed.rss">
        <link rel="alternate" type="application/atom+xml" href="/feed.atom">
      </head>
    `;
    const alts = findAlternates(html);
    expect(alts.map((a) => a.type)).toEqual(["application/rss+xml", "application/atom+xml"]);
    // Sanity: neither is in the allowlist, so the caller will skip both.
    for (const a of alts) expect(ALLOWED_ALTERNATE_TYPES.has(a.type)).toBe(false);
  });

  it("ignores <link> tags inside <body>", () => {
    // alternate-link discovery is a <head>-only mechanism. Some sites
    // inject inline <link> tags into article bodies (video embeds,
    // syndication tooling); those must not influence the fallback.
    const html = `
      <head>
        <link rel="stylesheet" href="/x.css">
      </head>
      <body>
        <link rel="alternate" type="${OEMBED_JSON}" href="/should-be-ignored.json">
      </body>
    `;
    expect(findAlternates(html)).toEqual([]);
  });

  it("handles a malformed <head> with no closing tag", () => {
    // No </head>. The fallback grammar terminates the scan window at <body>,
    // so a real-world unclosed-head page still produces correct results
    // instead of an empty list (or worse, scanning the body too).
    const html = `
      <html>
      <head>
        <link rel="alternate" type="${OEMBED_JSON}" href="/oembed.json">
      <body><link rel="alternate" type="${OEMBED_XML}" href="/in-body.xml"></body>
      </html>
    `;
    const alts = findAlternates(html);
    expect(alts).toHaveLength(1);
    expect(alts[0]?.type).toBe(OEMBED_JSON);
  });

  it("returns [] when there is no <head> at all", () => {
    expect(findAlternates("<body><p>no head</p></body>")).toEqual([]);
  });

  it("scans to end-of-string when <head> has no closer and no <body>", () => {
    // Truly malformed input — `<head>` opens but neither `</head>` nor
    // `<body>` ever appears (real-world fragment responses do this). The
    // HEAD_RE third fallback (`$`) intentionally treats the entire tail
    // as in-scope so we don't silently regress the happy path on servers
    // that ship non-conforming variants. Any picked-up <link> still has
    // to clear the call-site allowlist + same-origin + SSRF gates, so the
    // blast radius is bounded.
    const html = `<html><head><link rel="alternate" type="${OEMBED_JSON}" href="/late.json">`;
    const alts = findAlternates(html);
    expect(alts).toHaveLength(1);
    expect(alts[0]?.url).toBe("/late.json");
  });

  it("ignores commented-out <link> tags", () => {
    // Defense against an author pre-commenting alternates during a
    // migration; we don't want a stale oEmbed endpoint resurrected from
    // an HTML comment.
    const html = `
      <head>
        <!-- <link rel="alternate" type="${OEMBED_JSON}" href="/old.json"> -->
        <link rel="alternate" type="${OEMBED_JSON}" href="/new.json">
      </head>
    `;
    const alts = findAlternates(html);
    expect(alts).toHaveLength(1);
    expect(alts[0]?.url).toBe("/new.json");
  });

  it("treats rel as a token list ('alternate canonical' matches)", () => {
    // rel is a space-separated token list per the spec. Substring matching
    // would let "alternateAnything" through; tokenization keeps it strict.
    const html = `
      <head>
        <link rel="alternate canonical" type="${OEMBED_JSON}" href="/a.json">
        <link rel="alternateAnything" type="${OEMBED_JSON}" href="/b.json">
      </head>
    `;
    const alts = findAlternates(html);
    expect(alts).toHaveLength(1);
    expect(alts[0]?.url).toBe("/a.json");
  });

  it("skips entries without a type attribute", () => {
    // No type means "same media type as the current document" per the spec
    // — for an HTML page that's text/html, never in our allowlist. Drop
    // early so callers don't have to second-guess "" entries.
    const html = `
      <head>
        <link rel="alternate" href="/no-type">
        <link rel="alternate" type="${OEMBED_JSON}" href="/oembed.json">
      </head>
    `;
    const alts = findAlternates(html);
    expect(alts).toHaveLength(1);
    expect(alts[0]?.url).toBe("/oembed.json");
  });

  it("lowercases and trims the type attribute", () => {
    // Real-world HTML carries "  Application/JSON+oEmbed  " variants in the
    // wild. Normalizing here lets the call site compare against the
    // lowercase allowlist with a single Set lookup.
    const html = `
      <head>
        <link rel="alternate" type="  Application/JSON+oEmbed  " href="/x">
      </head>
    `;
    const alts = findAlternates(html);
    expect(alts).toHaveLength(1);
    expect(alts[0]?.type).toBe(OEMBED_JSON);
    expect(ALLOWED_ALTERNATE_TYPES.has(alts[0]!.type)).toBe(true);
  });
});
