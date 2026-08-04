← [ADR index](README.md) · [README](../../README.md) · see also: [PDF support](../pdf.md), [Content extraction](../extraction.md)

# 0001. Bounded single-entry memo for `webfetch` pagination

**Status:** Accepted
**Date:** 2026-08-04
**Issue:** [#211](https://github.com/bitcraft-apps/pi-web-tools/issues/211)
**Implemented by:** [#259](https://github.com/bitcraft-apps/pi-web-tools/issues/259)

## Context

`webfetch` holds no cache. Each call runs the full pipeline in
`src/lib/pipeline.ts`: fetch, decode, extract, convert, then `paginate`.

A paginated read of one document therefore repeats all of that work on every
call. The tool re-downloads the whole body to return a later chunk. For HTML it
re-spawns the extractor and the markdown converter. For PDF it re-spawns
`pdftotext` on the whole file. The total cost is quadratic in the number of
chunks.

The only control on that cost is advice. The first entry in `promptGuidelines`
asks the model to prefer one large `max_chars` over several `offset` reads.
Advice is not a mechanism. A model that paginates a 5 MB PDF pays the full cost.

The absence of a cache also creates reasoning debt in two places:

- `paginate` returns a past-end marker when a document shrank between calls.
- The JSON fence gate in the pipeline drops the ` ```json ` fences when the body
  does not fit one chunk. The gate is per-call, so a body that changed size
  between calls can wrap at one offset and stay unwrapped at another.

Both cases exist only because each call re-reads the source.

The absence of a cache is also a documented promise. `README.md` states "No
persistent state, no cache." Any cache contradicts that text, so the project
needs a recorded decision before implementation.

## Decision

Add one process-lifetime memo entry to the pipeline. Read the entry only for
continuation reads, which are calls with `offset > 0`.

```
offset === 0   fetch, extract, convert, store the string, then paginate
offset > 0     memo hit:  paginate the stored string, with no network request
               memo miss: fetch, exactly as before
```

The design has these properties:

- **Key: the validated input URL.** The lookup happens before any request, so
  the final URL after redirects is not yet known. The key is therefore
  `validateUrl(input.url).toString()`, not the final URL.
- **Value: the exact string that the first call passed to `paginate`.** That
  string includes the cross-host redirect notice. The offsets that the agent
  replays were measured against that same string. A value without the notice
  would shift every offset.
- **One entry.** A successful call with `offset === 0` for a different URL
  replaces the entry.
- **Write on success only.** A call that throws leaves the existing entry in
  place.
- **No `ETag` and no `Last-Modified`.** See the rejected alternatives below.
- **No expiry time.** See the rejected alternatives below.
- **No persistence and no sharing between processes.**

The memo needs a `__resetFetchMemoForTesting()` seam. The repository already
holds six process-lifetime caches with that shape. Examples are `probeOnce` in
`src/lib/which.ts`, `__setFetchForTesting` in `src/lib/http.ts`, and the agent
cache in `src/lib/ssrf-agent.ts`.

Note that `probeOnce` itself does not fit this need. It stores one promise
forever, with no key and no replacement. The memo needs a keyed entry that a
later call can replace.

## Consequences

**Pagination becomes linear.** A continuation read does no network request and
spawns no subprocess. The largest gain is the PDF path, which currently re-runs
`pdftotext` for every chunk.

**Peak heap grows by one document.** The bound is loose but real. The stored
string cannot be much larger than `MAX_RESPONSE_BYTES`, which is 5 MB. The
pipeline already reasons with the same loose bound when it validates `offset`.

**The freshness promise that matters stays intact.** A call with `offset === 0`
always reaches the network. No first read comes from memory.

**A continuation read cannot observe a change at the source.** It does no
network request, so it does not see that the page now returns 404, or moved, or
started to serve a Cloudflare challenge. This is accepted. A stable snapshot is
the correct answer for a caller that wants the rest of the document it already
started to read.

**`README.md` becomes wrong as written.** The state is per process and holds one
entry. The sentence "No persistent state, no cache" must change. Three
model-facing strings also state that there is no cache: the `promptGuidelines`
entry, the `offset` schema description, and the past-end marker in `paginate`.
All must change with the implementation.

**The mid-pagination guards stay.** Issue #211 suggests that a cache lets the
project simplify them. It does not, because a memo miss at `offset > 0` still
falls through to a fresh fetch. An interleaved fetch of a second URL produces
exactly that case. Therefore:

- The past-end marker in `paginate` stays required.
- The `offset === 0` clause in the JSON fence gate stays required.

Only the frequency of those paths falls. Do not delete either guard.

**The fence decision becomes stable on a memo hit.** The continuation replays
the exact string that the gate already chose. This removes the desynchronization
case, but only for a hit.

## Alternatives rejected

**1. Keep no cache, and rely on the prompt guideline.** Rejected. The guideline
is advice, and the worst case is the PDF path. A model that ignores the advice
pays a quadratic cost with no limit.

**2. Key the memo on the URL plus `ETag` or `Last-Modified`, as issue #211
proposed.** Rejected. A validator is only useful with a conditional request. A
conditional request costs one round trip for every chunk, and it does nothing on
a server that sends no validator. It also widens `doFetch` and the return shape
of `fetchWithRedirects`, because both discard response headers today. The
continuation-only design needs none of that.

**3. Put the memo behind an option that is off by default.** Rejected. Every
schema field enters every agent turn. `AGENTS.md` states the bar in "Bar for new
tools": new surface is not free. A control that gives no benefit at its default
value is a net loss.

**4. Give the entry an expiry time.** Rejected. A call with `offset === 0`
always reaches the network, so a fresh read is never stale. The only remaining
window is a much later continuation read. In that case the caller wants the rest
of the document it already read, so the stored snapshot is the better answer.
