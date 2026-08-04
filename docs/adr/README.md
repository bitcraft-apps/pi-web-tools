← [docs](../README.md) · [README](../../README.md)

# Architecture decision records

An ADR records one decision that shapes the code, and the reasons for it. Write
an ADR when a choice contradicts a documented promise, or when the reasons would
otherwise stay in an issue thread and get re-derived later.

Do not write an ADR for a normal change. The scope rules in
[`AGENTS.md`](../../AGENTS.md), the "What `webfetch` does *not* do" list in the
[README](../../README.md), and the `## Caveats` sections in the topic docs
already hold most decisions.

## Conventions

- **File name:** `NNNN-<slug>.md`. Pad the number to four digits.
- **Numbers are permanent.** Never renumber an existing ADR. Take the next
  unused number.
- **Title:** `# NNNN. <the decision>`.
- **Header:** `**Status:**`, `**Date:**` and `**Issue:**` lines, in that order.
  Add an `**Implemented by:**` line when the code lands under a separate issue.
- **Sections:** `## Context`, `## Decision`, `## Consequences`, and
  `## Alternatives rejected`. Use all four.
- **Status values:** `Accepted`, `Rejected`, or `Superseded by NNNN`.
- **Never rewrite an accepted ADR to change its decision.** Write a new ADR, and
  then set the old status to `Superseded by NNNN`. The record of the earlier
  decision must stay readable.

An ADR states a decision. A design doc at `docs/<topic>-design.md` states a
plan. A topic doc at `docs/<topic>.md` tells a user how a feature behaves.

## Contents

- [`0001-webfetch-pagination-memo.md`](0001-webfetch-pagination-memo.md) —
  accept a bounded single-entry memo for `webfetch` pagination.
- [`0002-in-band-markers.md`](0002-in-band-markers.md) — signal the model with
  markers inside the returned text, not with structured fields.
- [`0003-undici-own-fetch.md`](0003-undici-own-fetch.md) — call the installed
  undici's `fetch`, not Node's global one, so the SSRF dispatcher is honored.
