# Gallery preview asset

`.github/preview.png` is shown on <https://pi.dev/packages> via the
`pi.image` field in `package.json`.

## When to regenerate

- `websearch` output format changed (header, result layout, sanitization)
- The query "pi coding agent" returns substantially different results
  and the current frame looks stale
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
# 1. Recapture the fixture (hits live ddgr)
npx -y tsx .github/preview/capture.ts

# 2. Re-render the PNG
freeze --config .github/preview/freeze.json \
       --output .github/preview.png \
       .github/preview/websearch-output.ans

# 3. Sanity-check both files were updated before committing.
# `freeze` can fail silently and leave a stale PNG paired with a
# fresh fixture, so eyeball `git status` first.
git status .github/preview/websearch-output.ans .github/preview.png
git add .github/preview/websearch-output.ans .github/preview.png
git commit -m "chore(gallery): refresh preview asset"
```

## Why a fixture file?

Captured output is committed so the render is reproducible without
network and stable across reruns. Re-capture only when output format
or query results have meaningfully changed.
