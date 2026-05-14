# `docs/`

Two kinds of documents live here:

## Current docs

User-facing topic docs as `docs/<topic>.md` (e.g. `docs/extraction.md`,
`docs/pdf.md`). Design/architecture docs that outlive the implementing PR go
next to them as `docs/<topic>-design.md`. These are maintained alongside the
code.

## Historical record: `docs/superpowers/`

`docs/superpowers/plans/` and `docs/superpowers/specs/` hold implementation
plans and design specs from the agent-driven workflow described in
[`AGENTS.md`](../AGENTS.md). The `superpowers/` name is the established
skill-pack convention.

These files are a **record, not living docs** — pinned to the date and branch
they were authored against (filenames are date-stamped) and not updated when
the surrounding code drifts. Read them for context on *why* a change was made;
don't trust them as current reference.

## See also

- [`AGENTS.md`](../AGENTS.md) — PR/commit conventions, scope rules.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — contributor entry point.
