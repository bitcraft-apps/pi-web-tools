← [ADR index](README.md) · [README](../../README.md) · see also: [ADR 0001](0001-webfetch-pagination-memo.md)

# 0002. In-band markers are the model contract

**Status:** Accepted
**Date:** 2026-08-04
**Issue:** [#132](https://github.com/bitcraft-apps/pi-web-tools/issues/132), [#133](https://github.com/bitcraft-apps/pi-web-tools/issues/133)

## Context

`webfetch` returns one string. There is no structured field in which to tell the
model "more of this document remains", "these bytes came from a different host
than you asked for", or "the offset you passed is past the end". Every such
signal has to travel inside the returned text.

Three markers use that channel today:

- **The truncation footer**, `[TRUNCATED — returned chars [X, Y) of Z total.
  Re-call with offset=Y to read the next chunk.]`, appended by `paginate` in
  `src/lib/paginate.ts` to every chunk that is not the last one. Issue #132.
- **The cross-host redirect notice**, `[REDIRECTED — input was …, final URL is
  …]`, prepended in `src/lib/pipeline.ts`. Issue #133.
- **The past-end marker**, `[OFFSET N PAST END — document is Z chars total …]`,
  returned by `paginate` in lieu of a chunk when `offset >= text.length`.

All three are constrained by one invariant. `paginate` slices half-open
`[offset, end)` chunks that tile exactly, and the next-chunk hint reuses `end`
as the inclusive start of the following call. The offsets an agent replays must
therefore mean the same thing on the next call. A marker that moved the
boundaries would corrupt the tiling.

The rationale for each marker is written where it is emitted, and the wording is
quoted in `README.md` under "## Limits and behavior". Nothing states that the
three are one contract, or that the tiling is what binds them.

## Decision

Signal the model with markers inside the returned text. Treat the three markers
as one contract with these properties:

- **In-band, not structured.** `pipeline.ts` already names the rule at the
  redirect notice: "Same channel as the trailing `[TRUNCATED — …]` footer;
  in-band marker, not a structured field."
- **A marker must not shift the offsets.** The footer is appended after the
  slice, so it lands past `end` and outside the tiling. The notice is prepended
  to the *source* string handed to `paginate`, so it lives inside the tiling and
  chunk 0 carries it while later chunks do not.
- **Past-end returns a marker, not an exception.** Past-end is reachable from a
  legitimate "next chunk" request near the tail, and the value is unambiguous.
  A marker keeps boundary detection out of every caller.
- **The footer wording has a single source of truth.**
  `PAGINATION_FOOTER_PARTS` builds both the emitted string and the strip regex,
  so a reword cannot desync them.
- **`stripPaginationFooter` does not strip the past-end marker.** The marker
  replaces a chunk rather than annotating one. A caller that walks one chunk
  past the tail filters it at the call site.
- **An empty document at `offset === 0` returns `""`.** The past-end recovery
  marker there would tell the model it asked for the wrong offset, which is
  false.
- **The notice strips userinfo** from the final URL before echoing it, so a
  redirect to `https://user:token@evil.example/` does not leak the credential
  into markdown the model then logs.

## Consequences

**A reword is a three-place change.** The wording lives in code, is quoted in
`README.md`, and is asserted in `test/paginate.test.ts`. The `NOTE:` block above
`PAGINATION_FOOTER_PARTS` says so for the footer, and the last test in
`test/paginate.test.ts` fails until the README bullet matches. The past-end
marker's wording changed in 1.6.0 under #259 and #261 and touched all three.

**The drift guard is asymmetric.** Only the footer has both a parts array and a
code-versus-prose test. The `[REDIRECTED — …]` line is an inline template
literal in `pipeline.ts` quoted verbatim in `README.md` with no equivalent
guard, and the past-end marker's wording is asserted only by substring matches.
Those two rely on review.

**ADR 0001 depends on this contract.** A memo hit replays the exact string the
first call passed to `paginate`. That is why the stored value includes the
redirect notice: a value without it would shift every offset the agent replays.

**The contract cannot be validated.** It is prose that a model reads. A page
whose own text contains a bracketed all-caps line is indistinguishable from a
marker. The bracketed shape makes collision unlikely, not impossible.

**Provenance is lost on chunks past the first.** The agent saw the notice on the
chunk 0 response that produced the offset it is now replaying, so this is
accepted.

## Alternatives rejected

**1. Return structured fields instead, such as `{text, truncated, nextOffset,
finalUrl}`.** Rejected. The tool returns a string, and every field of a return
shape is surface the model must be taught. `AGENTS.md` states the bar in "Bar
for new tools": new surface is not free.

**2. Throw on past-end instead of returning a marker.** Rejected. It forces
boundary-detection logic into every caller for a value the tool already knows
unambiguously.

**3. Repeat the redirect notice on every chunk.** Rejected. Issue #133 settled
on one notice line as the contract. Re-emitting it would shift offsets across
chunks and break the half-open tiling.

**4. Fold the host comparison to eTLD+1, so `example.com` and `www.example.com`
produce no notice.** Rejected in #133. The comparison is strict `URL.host`
equality, with no public-suffix list. A port change is worth flagging too.

**5. Add a "retry from offset=0" hint to the past-end marker.** Rejected. An
agent only reaches past-end because the document shrank between calls, in which
case a restart hits the same race, or because its own offset arithmetic is off,
in which case a restart wastes a fetch. The honest signal is that the prior
chunk was already the tail.
