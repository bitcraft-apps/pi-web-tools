# Gallery preview asset

`.github/preview.png` is shown on <https://pi.dev/packages> via the
`pi.image` field in `package.json`.

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

- `websearch` output format changed (header, result layout, sanitization)
- The query "pi coding agent" returns substantially different results
  and the current frame looks stale
- The fixture's snippets contain time-sensitive marketing copy (model
  version numbers, release dates, etc.) that's now visibly aged
- You want to swap fonts/theme/dimensions

## Regen

Prereqs:

- [`freeze`](https://github.com/charmbracelet/freeze) on PATH
  (`brew install charmbracelet/tap/freeze`)
- [`ddgr`](https://github.com/jarun/ddgr) on PATH (`brew install ddgr`)
- Node ≥ 20

The capture script imports `.ts` source directly (e.g.
`../../src/websearch.ts`). `tsx` resolves those imports; plain
`node` (even with `--experimental-strip-types`) does not, because the
imports use the `.ts` extension rather than a `.js` shim.

```bash
# Runs capture → freeze → freshness check. Exits non-zero if any
# step fails or freeze leaves a stale PNG behind.
.github/preview/regen.sh

git add .github/preview/websearch-output.ans .github/preview.png
git commit -m "chore(gallery): refresh preview asset"
```

The freshness check (`png -nt fixture`) is what prevents the silent-
failure mode where `freeze` exits 0 without writing — don't replace
the script with bare `freeze` invocations in CI or muscle memory.

## Why a fixture file?

Captured output is committed so the render is reproducible without
network and stable across reruns. Re-capture only when output format
or query results have meaningfully changed.
