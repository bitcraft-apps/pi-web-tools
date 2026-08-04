# `docs/`

User-facing topic docs as `docs/<topic>.md` (e.g. `docs/extraction.md`,
`docs/pdf.md`). Design/architecture docs that outlive the implementing PR go
next to them as `docs/<topic>-design.md` (none yet). Decision records live
separately in [`docs/adr/`](adr/README.md): a design doc states a plan, an ADR
states one decision and its reasons. These are maintained alongside the code.

## Contents

- [`adr/`](adr/README.md) — architecture decision records.
- [`extraction.md`](extraction.md) — optional Reader-View extraction of page content.
- [`pdf.md`](pdf.md) — optional `pdftotext` support for `application/pdf`.
- [`release-runbook.md`](release-runbook.md) — what to do when an npm publish fails.

## See also

- [`AGENTS.md`](../AGENTS.md) — PR/commit conventions, scope rules.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — contributor entry point.
