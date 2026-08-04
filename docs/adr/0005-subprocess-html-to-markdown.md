← [ADR index](README.md) · [README](../../README.md) · see also: [`AGENTS.md`](../../AGENTS.md), [Content extraction](../extraction.md), [PDF support](../pdf.md)

# 0005. HTML becomes markdown through a `pandoc` or `w3m` subprocess, not an npm library

**Status:** Accepted
**Date:** 2026-08-04
**Issue:** [#265](https://github.com/bitcraft-apps/pi-web-tools/issues/265)

## Context

`webfetch` has one irreducible job beyond the request itself: turn arbitrary,
attacker-supplied HTML into markdown. Something has to parse that HTML.

Shell-only is the constraint the package is built on. The
[README](../../README.md) sells it as "zero API keys, zero accounts — just
`ddgr` + `pandoc`/`w3m` running locally," and the "Out of scope (deliberately
rejected)" list in [`AGENTS.md`](../../AGENTS.md) rules out a build step,
headless browsers, and JS execution. Every other external capability already
arrives as a child process: `ddgr` for search (`src/lib/ddgr.ts`),
`trafilatura`/`rdrview` for the extraction pre-pass (`src/lib/extract.ts`),
`pdftotext` for PDFs (`src/lib/pdf.ts`). A converter is not a special case — it
is the same idiom.

`AGENTS.md` states the rule in one line ("**HTML→markdown npm libraries**
(Turndown, etc.). Pandoc/w3m via subprocess is the design"). It does not state
the cost, which is a runtime dependency the user must install and an error path
when they have not. This record holds the reasoning; the `AGENTS.md` line stays
as policy.

## Decision

Convert by spawning `pandoc`, falling back to `w3m`, through the shared
subprocess wrapper. `src/lib/html2md.ts` is the whole implementation.

- **Detection is a `$PATH` probe, cached per process.** `detectConverter`
  prefers `pandoc`, falls back to `w3m`, and returns `null` when neither is
  present. `commandExists` (`src/lib/which.ts`) uses POSIX `command -v` so it
  works on busybox and distroless images (#149); `probeOnce` collapses it to one
  probe per process (#6), and a negative result sticks — a binary installed
  mid-process is not picked up until restart.
- **The argv is fixed and exported.** `PANDOC_ARGS`
  (`markdown_strict`, `--wrap=none`) and `W3M_ARGS` (`-dump -T text/html -cols
  120`) are asserted as literals by `test/html2md.test.ts` and executed against
  the real binaries by `test/contract/pandoc.test.ts` and
  `test/contract/w3m.test.ts` (#216), so a wrong edit fails twice — once on
  shape, once against the installed converter. The header comment in
  `html2md.ts` explains why each flag is there; this record does not repeat it.
- **The child runs under `runCommand`.** `src/lib/run-command.ts` supplies a 10 s
  timeout for this call site, the shared 50 MB stdout cap, decode-once at close,
  and a stdin error handler. Four call sites used to hand-roll that plumbing and
  the copies drifted (#202, #203); centralizing it is what makes reaching for a
  subprocess cheap and uniform rather than a fresh set of mistakes each time.
- **Output is normalized once, after the converter.** `stripBase64DataUris` runs
  on the converter's stdout, not on the input HTML, so it covers pandoc, w3m, and
  any future renderer without per-converter wiring (#127).

## Consequences

**A runtime dependency the user must install.** This is the cost accepted. It
shows up in the install block, the `Need pandoc or w3m installed` entry in
Troubleshooting, the binary-probe loop in `.github/ISSUE_TEMPLATE/bug.yml`, and
the `contract.yml` workflow, which installs both converters so the contract
suite has something to run against.

**No converter is a hard error, not a degradation.** `htmlToMarkdown` throws
`Need pandoc or w3m installed. brew install pandoc`. This is deliberately unlike
the extraction path, where `extractContent` returns `null` and the pipeline falls
through to the full page: there, a fallback exists. Here it does not, so the
failure is loud and names its own fix.

**Two converters means two output styles.** pandoc emits `markdown_strict`;
w3m emits a 120-column text dump with no markdown syntax at all. The pinned argv
keeps the variance bounded, and the contract tests catch it when a binary's
behavior changes underneath us.

**The HTML parser runs out of process.** A malformed-input bug in it is contained
in a child that the timeout and the byte cap can kill, and the package carries no
in-process HTML or DOM dependency to keep patched. The cost is `$PATH` trust: the
agent process inherits the user's `$PATH`, so a poisoned earlier entry runs as
the converter — the same posture recorded for the extractors in
[`docs/extraction.md`](../extraction.md).

## Alternatives rejected

**1. Turndown, or another npm HTML→markdown library.** Turndown needs a DOM, so
this pulls jsdom or parse5 into the process — a large parser running on
attacker-controlled input, in the agent's own heap, with no timeout and no
memory cap of the kind `run-command.ts` gives a child. It also converts the
package's headline claim from "shell-only" into "shell-only except for the part
that parses the untrusted bytes."

**2. Vendor or bundle a converter.** Blocked by the no-build-step rule: pi loads
raw `.ts` via jiti, so there is nothing in the pipeline that could bundle a
parser even if one were wanted.

**3. Require `pandoc` only, and drop the `w3m` fallback.** Rejected. `w3m` is
the far smaller install of the two, which matters on a machine where the user
wants one working converter and not a document-conversion toolchain, and the
fallback costs exactly one `commandExists` probe plus one argv array.

**4. Degrade to raw HTML, or a regex tag-stripper, when no converter is found.**
Rejected in favor of the throw. Returning tag soup labelled as markdown breaks
the tool's contract with the model — the same contract the in-band markers in
[ADR 0002](0002-in-band-markers.md) depend on — and it would fail quietly, on
every fetch, for a user one `brew install` away from working output.
