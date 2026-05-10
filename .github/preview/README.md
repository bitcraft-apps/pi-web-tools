# Preview assets

This directory holds the capture scripts, fixtures, and config for two
PNG screenshots:

- **`.github/preview.png`** — websearch screenshot. Shown on
  <https://pi.dev/packages> via the `pi.image` field in `package.json`,
  and embedded under the `websearch` subsection in the repo `README.md`.
- **`.github/webfetch.png`** — webfetch screenshot. Embedded under the
  `webfetch` subsection in `README.md`. **Not** referenced by `pi.image`
  and not guarded by `preview-image-check.yml`'s HEAD check —
  rationale: a missing inline README image is self-evident the next
  time anyone opens the README, while a missing `pi.image` is invisible
  to the maintainer (only seen by pi.dev visitors). Different failure
  modes → different guards.

## Why `pi.image` points at `main`, not a tag/SHA

The `pi.image` URL is intentionally pinned to the `main` branch
(`raw.githubusercontent.com/…/main/.github/preview.png`), not a
release tag or commit SHA. Reasoning:

- Gallery thumbnails should reflect the *current* tool output, not
  whatever shipped in the last npm release.
- A regen lands on `main` and the gallery picks it up immediately,
  with no version bump required.
- The breakage surface (force-push, rename, repo move) is covered by
  `preview-image-check.yml` on push-to-main, PRs touching the asset,
  and a weekly cron — see that workflow's header for the gap analysis.

If we ever need a per-release frozen thumbnail, switch the URL to
`/raw/v<X.Y.Z>/.github/preview.png` and accept that regens won't be
visible in the gallery until the next release.

## When to regenerate

**Either tool:**

- Output format changed (header layout, sanitization, ANSI role usage)
- You want to swap fonts/theme/dimensions in `freeze.json` (regen both
  so the README screenshots stay visually paired)

**`websearch` only:**

- The query "pi coding agent" returns substantially different results
  and the current frame looks stale
- The fixture's snippets contain time-sensitive marketing copy (model
  version numbers, release dates, etc.) that's now visibly aged

**`webfetch` only:**

- The Wikipedia "Unix philosophy" article was edited in a way that
  changes the first ~25 rendered lines (rare; this is why the URL was
  picked)
- `pandoc` / extraction tooling output changed enough that the
  rendered markdown looks visibly different

## Regen

Prereqs:

- [`freeze`](https://github.com/charmbracelet/freeze) on PATH
  (`brew install charmbracelet/tap/freeze`)
- [`ddgr`](https://github.com/jarun/ddgr) on PATH (`brew install ddgr`)
- [`pngquant`](https://pngquant.org/) on PATH (`brew install pngquant` /
  `apt install pngquant`) — lossy palette quantize, takes the raw
  freeze output from ~450KB to ~50KB with no perceptible loss on
  terminal screenshots
- Node ≥ 20

The capture scripts (`capture-websearch.ts`, `capture-webfetch.ts`)
import `.ts` source directly (e.g. `../../src/websearch.ts`,
`../../src/webfetch.ts`). `tsx` resolves those imports; plain `node`
(even with `--experimental-strip-types`) does not, because the imports
use the `.ts` extension rather than a `.js` shim.

```bash
# Runs capture → freeze → freshness check → pngquant → size floor for
# each selected tool. Exits non-zero if any step fails or freeze leaves
# a stale PNG behind.
.github/preview/regen.sh                # both tools (default)
.github/preview/regen.sh websearch      # just websearch
.github/preview/regen.sh webfetch       # just webfetch

# Default-both is the right answer after a formatter change or
# freeze.json edit. Single-tool runs exist for when one URL is
# transiently flaky and you don't want a network blip blocking the
# other refresh.

git add .github/preview/websearch-output.ans .github/preview.png \
        .github/preview/webfetch-output.ans .github/webfetch.png
git commit -m "chore(preview): refresh assets"
```

The freshness check (`png -nt fixture`) is what prevents the silent-
failure mode where `freeze` exits 0 without writing — don't replace
the script with bare `freeze` invocations in CI or muscle memory.

## Why a fixture file?

Captured output is committed so the render is reproducible without
network and stable across reruns. Re-capture only when output format
or query results have meaningfully changed.
