← [ADR index](README.md) · [README](../../README.md) · see also: [Content extraction](../extraction.md), [ADR 0005](0005-subprocess-html-to-markdown.md)

# 0006. The extraction pre-pass is gated by a 10 KB body floor and a 1% output-to-input ratio

**Status:** Accepted
**Date:** 2026-08-04
**Issue:** [#266](https://github.com/bitcraft-apps/pi-web-tools/issues/266)

## Context

The content-extraction pre-pass ([`docs/extraction.md`](../extraction.md)) is the single
largest output-size win `webfetch` has: on chrome-heavy pages it cuts the returned
markdown by 5–20×. It is also the step most likely to be wrong, because Readability-style
extraction is a heuristic running on pages that were not written for it.

`extractContent` (`src/lib/extract.ts:63-72`) already handles the loud failures. It
returns `null` for three distinct situations — no extractor on `$PATH`, the extractor
exited non-zero, the extractor timed out — and its doc comment states the contract:
"Extractor failure is intentionally swallowed: the extractor is an optimization, not a
contract. The caller must still produce output." Every caller falls back to the full HTML
on `null`.

What `null` does not cover is the quiet failure: the extractor runs, exits 0, and returns
the wrong thing. A page with no `<article>` yields a footer. A JS shell yields the "enable
JavaScript" interstitial. Some pages yield literally `""`. In all three the tool would
return a confident, tiny, useless result — worse than the pre-extraction behavior it
replaced, because the size makes it look correct.

Two thresholds catch that class, and a third narrows a downstream fallback:

- a **10 KB body floor** below which the extractor is not spawned at all,
- a **1% output-to-input ratio** below which its output is rejected, and
- a **200-char floor** that `&&`-narrows the thin-extraction alternate-link fallback.

All three are unnamed inline literals in `src/lib/pipeline.ts:397-423`, and both numbers
moved during implementation — which is the evidence this record exists to hold. #37
originally proposed a single heuristic, `extracted < 200 chars && original > 10 KB`. The
disposition table in that issue's own thread records why it changed before shipping:
"Ratio-based encodes the failure model more directly ('extractor threw away >99% of
input, probably wrong')." Then #128 needed an absolute floor again, for a narrower
purpose, and PR #134 review pinned it to `&&` rather than the `||` the issue sketched.

Both numbers are also quoted verbatim to users, in the `## Caveats` bullets of
[`docs/extraction.md`](../extraction.md). Those bullets say what happens. This record says
why these numbers, and — more importantly — what they provably do not cover.

## Decision

Gate the pre-pass on size, in `src/lib/pipeline.ts`, with the thresholds stated inline and
justified by the comments they sit next to.

- **Skip the extractor when the body is under 10 KB** (`pipeline.ts:397`). RSS items, API
  HTML and error pages have no chrome worth stripping, so the process spawn does not pay
  for itself. The cost being avoided is the spawn, not the timeout: `EXTRACT_TIMEOUT_MS`
  (`src/lib/extract.ts:8`) is 10 s, but it is "a catastrophe backstop, not a routine
  bound" — real per-call subprocess time is tens of ms. The floor is also deliberately
  imprecise. `body.length` is a JS string length in UTF-16 code units, not bytes, so on
  non-ASCII pages 10 KB of `length` is not 10 KB of payload. Accepting that fuzziness is
  part of the decision: the floor separates "trivially small" from "worth a spawn," and
  that boundary does not need to be tight.

- **Reject extractor output below 1% of the input** (`pipeline.ts:398`, `useExtracted`). A
  ratio rather than an absolute count, because the failure being modelled is proportional:
  the extractor discarded more than 99% of the page. Unlike the floor, this comparison
  *is* unit-correct — both sides are `length` in the same UTF-16 code units, so the
  encoding fuzziness cancels. An extractor returning `""` passes the `!== null` check and
  then fails the ratio, which is the intended route to the full-HTML fallback rather than
  an accident.

- **State the coverage boundary, because it is the part that will be forgotten.** The
  ratio catches Readability false-negative modes 1 (empty output) and 2 (trivial output).
  It does **not** catch mode 3 (wrong-but-substantial — the extractor picked a large
  container that is not the article) or mode 4 (stripped tables and code blocks adjacent
  to the article body). Both are "unfixable without semantic analysis," per the code
  comment and #37's disposition. Moving the ratio cannot fix 3 or 4; a future tune that
  claims to is the specific mistake this record is written to prevent. Mode 4 is why the
  extractor runs at default precision/recall rather than `--precision`
  (`TRAFILATURA_ARGS`, `src/lib/extract.ts:21`).

- **The 200-char floor applies only inside the thin-extraction branch, joined with `&&`**
  (`pipeline.ts:423`, `looksThin`, #128). Three conjuncts, each load-bearing.
  `extracted !== null` rules out both "body too small to bother" and "no extractor /
  extractor failed" — without it, every fetch on an extractor-less host would pay the
  head-scan and a possible extra HTTP round-trip, contradicting the cost-control promise
  in the README. `!useExtracted` reuses the same condition that already disqualified the
  output for the main pipeline. `< 200` then adds a hard floor so a 10–20 KB page with a
  borderline-1% extraction still qualifies for the alternate-link lookup. Above 20 KB a
  passing 1% already implies more than 200 chars, so the floor is a no-op there; it
  matters only in that 10–20 KB band, where 1% can be a few tens of characters.

- **`||` is the rejected form, and two tests hold that line.**
  `test/pipeline.test.ts:1047` keeps a 150-char extraction on a 10 KB body (1.5% — above
  the ratio, genuinely correct, merely short), and `test/pipeline.test.ts:1070` pins the
  exact boundary: 199 chars on a 19 800-char body, ≈1.005%, one character of headroom on
  the ratio. Under `||` the length test would dominate both and replace real content with
  an oEmbed stub.

## Consequences

**Three magic numbers, none of them named constants.** `10_000`, `0.01` and `200` are
unexported literals whose entire justification is the comment block above them. This is
unlike `WEBFETCH_PREVIEW_MAX_LINES` (`src/webfetch.ts:99`) or `RETRY_AFTER_MAX_MS`
(`src/lib/http.ts:350`), which are named exports carrying their own rationale. Accepted:
each has exactly one call site, and hoisting them to named constants would move the
reasoning away from the arithmetic it explains — the three interact (the 200-char floor is
only meaningful relative to what 1% of 10–20 KB is), and that interaction is only legible
when they are read together. Recorded here so the absence reads as a choice.

**The 10 KB floor is not pinned by a boundary test.** `test/pipeline.test.ts:766` exercises
the skip with a 500-char body and `:746` the ratio with a 20 KB one, so moving the floor to
5 KB or 15 KB leaves the whole suite green. The ratio has one tight boundary case
(`:1070`); the floor has none. Named, not fixed, under this issue.

**One stale arithmetic aside in the code comment.** `pipeline.ts:391` says an empty
extraction "passes the null-check and then 0 < 100" — `100` was the pre-ratio constant,
and under `>= 0.01 * body.length` the figure on a 20 KB body is 200. The conclusion the
sentence draws is still correct, and the comment is left as written: #266 asks that the
comments this record links to not be rewritten.

**Changing either number is a user-visible change.** Both appear in
[`docs/extraction.md`](../extraction.md) — "< 1% of the original and the original was
> 10 KB" in the fallback caveat, and "< 1% of input *and* < 200 chars" in the
alternate-link caveat. A tune has to move the doc in the same change, or the documented
behavior stops matching the shipped behavior.

**Pages under 10 KB get no chrome-stripping at all.** A 9 KB nav-heavy page is converted
whole, including its chrome. Accepted because the waste is bounded by the body size
itself — 9 KB against a 200k-char per-call cap — and because the alternative is a
process spawn on every small HTML fetch.

**Extraction correctness is bounded by size, not meaning.** The gate is the only check on
extractor output, so modes 3 and 4 reach the model as confident, well-formed, wrong
markdown. `webfetch` has no signal it could use to notice, and no per-call opt-out to
recover with; the documented recovery is to open an issue with the URL.

## Alternatives rejected

**1. An absolute character floor only (`extracted < 200`), as #37 first proposed.** Does
not scale with the page. 200 characters is a plausible correct extraction on a short page
and a catastrophic one on a 500 KB page, so a single constant is either too aggressive at
one end or inert at the other. Replaced by the ratio before the feature shipped; #37's
disposition table records the reasoning.

**2. `||` between the ratio and the 200-char floor, as #128's sketch had it.** Rejected at
PR #134 review. A 150-char correct extraction on a 10 KB body is 1.5% and must be kept,
but under `||` the length test alone would discard it and substitute an oEmbed stub —
turning the fallback into a regression on exactly the short, correct pages it was not
meant to touch. Two regression tests now pin the `&&`.

**3. No floor — always run the extractor.** Pays a process spawn on every HTML fetch,
including RSS items, API responses and error pages, none of which have chrome to strip.
The ratio guard cannot fire usefully on a 500-byte body either, so the spawn buys nothing
even in principle.

**4. Semantic validation of the extractor's output instead of a size heuristic.** The only
approach that would catch false-negative modes 3 and 4, and the reason it is rejected is
the same one recorded in [ADR 0005](0005-subprocess-html-to-markdown.md): it needs a
second parser — or a model call — running on attacker-controlled HTML in the hot path of
every fetch. That contradicts the shell-only constraint the package is built on, for a
class of failure the tool can survive by returning a larger, complete result.

**5. A per-call opt-out (`raw: true`), as #37's API sketch proposed.** Not implemented;
[`docs/extraction.md`](../extraction.md) states there is "currently no per-call opt-out"
and asks users to open an issue with the URL when extraction strips something wanted. The
sketch is recorded here as the shape that was proposed and not built, not as a decision
with a rationale — none was written down.
