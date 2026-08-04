// Chunking of the extracted markdown for the LLM.
//
// This module slices a document into half-open `[offset, end)` chunks and owns
// the TRUNCATED footer wording. Pagination via `offset` is the only way to
// reach content past MAX_CHARS_HARD_CAP — see issue #132. Sequential chunks
// tile exactly, so a caller that strips the footers can concatenate them
// losslessly.

// Slice the extracted markdown for the LLM. Pagination via `offset` is the
// only way to reach content past MAX_CHARS_HARD_CAP — see issue #132. The
// footer is the sole signaling channel: when more remains, it names the
// exact next offset; when the slice reaches end-of-document, no footer is
// appended; when offset overshoots the document, a self-correcting marker
// is returned in lieu of an error so the model can recover.
//
// Validates its own inputs — `fetchAsMarkdown` also pre-validates, but
// `paginate` is exported, so direct callers must not be able to wedge it into
// a past-end loop with a maxChars of 0.
export function paginate(text: string, offset: number, maxChars: number): string {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid offset: ${offset} (must be a non-negative integer)`);
  }
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error(`Invalid maxChars: ${maxChars} (must be a positive integer)`);
  }
  const total = text.length;
  // Empty document at offset=0 is a legitimate result (e.g. 204-shaped
  // text body, blank markdown after extraction); return "" rather than
  // a past-end recovery marker, which would mislead the model into
  // thinking it asked for the wrong offset.
  if (total === 0 && offset === 0) return "";
  if (offset >= total) {
    // Past-end is reachable via legitimate "next chunk" requests near the
    // tail; throwing would force the caller to add boundary-detection
    // logic for a value we know unambiguously. A self-describing marker
    // is better UX than an exception.
    //
    // No "retry from offset=0" hint: an agent only reaches past-end when
    // (a) the document shrank between calls (race; restart hits the same
    // race) or (b) its own offset arithmetic is off (restart wastes a
    // fetch). The honest signal is "the prior chunk was already the
    // tail" — the caller decides whether to re-fetch from 0 or stop.
    return `[OFFSET ${offset} PAST END — document is ${total} chars total. If the document was expected to be longer, it shrank between calls (no cache; each fetch re-runs the pipeline).]`;
  }
  let end = Math.min(offset + maxChars, total);
  // Snap end down by one if the chunk would end mid-surrogate-pair: a lone
  // high surrogate in the chunk text isn't just cosmetic — the agent's JSON
  // transport stringifies tool output, and `JSON.stringify` of a lone
  // surrogate emits a `\udxxx` escape that downstream UTF-8 decoders may
  // reject (well-formed-JSON consumers since RFC 8259 §8.2). Mirroring the
  // snap into the next-offset keeps the half-open [offset, end) tiling
  // exact, so chunks still concatenate losslessly.
  //
  // Skip when the chunk reaches end-of-document (no next call to receive
  // the deferred low surrogate) or when the chunk is one char long
  // (snapping would empty the slice — the high half ships now and the
  // low half ships at the next offset). Production callers can't reach
  // maxChars=1: webfetch's schema states `minimum: 2` (#248) and
  // `fetchAsMarkdown` clamps every caller to that same floor. The branch
  // survives only for `paginate`'s exported test surface, which still
  // accepts 1.
  //
  // The guard is intentionally one-sided (chunk *end* only). At the
  // chunk *start* the symmetric case — `offset` landing on a lone low
  // surrogate — can only happen if a previous call shipped a lone high
  // surrogate (i.e. the maxChars=1 escape hatch above fired).
  // `fetchAsMarkdown`'s clamp forbids maxChars=1 in production, so the
  // asymmetry is a true invariant; adding a start-side snap would silently drop
  // the low half and break the half-open [offset, end) tiling guarantee.
  if (end < total && end - 1 > offset) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
  }
  const slice = text.slice(offset, end);
  if (end >= total) return slice; // last chunk — no footer
  // Range is half-open: `offset` is inclusive, `end` is exclusive (matches
  // String.prototype.slice). The next-chunk hint reuses `end` as the
  // inclusive start of the following call, so [offset, end) tiles cleanly.
  return slice + buildPaginationFooter(offset, end, total);
}

// Single source of truth for the pagination footer wording. The emitted
// string and the strip regex are both derived from the template parts
// below so a reword can't desync them — a typo in the literal would
// otherwise silently no-op `stripPaginationFooter` and break
// reconstruction tests. Kept module-private; tests strip via
// `stripPaginationFooter`.
//
// NOTE: README.md quotes this footer wording verbatim in the `webfetch
// pagination` bullet under "## Limits and behavior". If you reword the
// parts below, update that bullet too — the last test in
// test/paginate.test.ts fails until you do.
const PAGINATION_FOOTER_PARTS = [
  "\n\n[TRUNCATED — returned chars [",
  ", ",
  ") of ",
  " total. Re-call with offset=",
  " to read the next chunk.]",
] as const;

function buildPaginationFooter(offset: number, end: number, total: number): string {
  const [a, b, c, d, e] = PAGINATION_FOOTER_PARTS;
  return `${a}${offset}${b}${end}${c}${total}${d}${end}${e}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PAGINATION_FOOTER_RE = new RegExp(
  PAGINATION_FOOTER_PARTS.map(escapeRegex).join("\\d+") + "$",
);

/**
 * Strip the trailing TRUNCATED footer (if any) from a paginated chunk so
 * sequential chunks can be concatenated for reconstruction. Co-located
 * with `paginate` and the footer regex so a footer reword stays
 * single-source-of-truth. Exported for tests; production callers don't
 * need this — the agent threads `offset` forward without reassembling.
 *
 * Does NOT strip the `[OFFSET N PAST END …]` marker: that marker is a
 * standalone diagnostic returned in lieu of a chunk, not a footer
 * appended to one. Reconstruction tests bound their offsets to the body
 * and never observe it; if you walk one chunk past the tail (e.g. as a
 * boundary probe), filter the marker at the call site rather than
 * teaching this helper to swallow it.
 */
export function stripPaginationFooter(s: string): string {
  return s.replace(PAGINATION_FOOTER_RE, "");
}
