# Preview assets

This directory holds the capture scripts, fixtures, tape, and config
for three assets:

- **`.github/preview.mp4`** — ~18s recording of `websearch` and
  `webfetch` running for real. Shown on <https://pi.dev/packages> via
  the `pi.video` field in `package.json`; the gallery autoplays it on
  hover and opens a fullscreen player on click. **`pi.video` takes
  precedence over `pi.image`**, so this is what most visitors see.
- **`.github/preview.png`** — websearch screenshot. The `pi.image`
  fallback for gallery clients that don't render video, and embedded
  under the `websearch` subsection in the repo `README.md`.
- **`.github/webfetch.png`** — webfetch screenshot. Embedded under the
  `webfetch` subsection in `README.md`. **Not** referenced by the `pi`
  manifest and not guarded by `preview-image-check.yml`'s HEAD check —
  rationale: a missing inline README image is self-evident the next
  time anyone opens the README, while a missing `pi.image`/`pi.video`
  is invisible to the maintainer (only seen by pi.dev visitors).
  Different failure modes → different guards.

The MP4 is not embedded in the repo `README.md`: GitHub won't autoplay
a relative MP4 in an `<img>`, so the two PNGs remain the right inline
artifact there.

## Why `pi.image` / `pi.video` point at `main`, not a tag/SHA

Both URLs are intentionally pinned to the `main` branch
(`raw.githubusercontent.com/…/main/.github/preview.{png,mp4}`), not a
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

## How the pieces fit

```
                  ansi-theme.ts
                        │
      render-websearch.ts   render-webfetch.ts        ← query, URL, theme,
                  │                   │                 line budget
      ┌───────────┴─────────┬─────────┴───────────┐
      │                     │                     │
capture-websearch.ts   capture-webfetch.ts    demo-cli.ts
      │                     │                     │  (aliased by demo.tape)
websearch-output.ans   webfetch-output.ans      stdout
      │                     │                     │
   freeze                freeze                  vhs
      │                     │                     │
 preview.png           webfetch.png          preview.mp4
```

`render-*.ts` own the one definition of *what the preview shows* — the
query, the URL, the ANSI theme (`ansi-theme.ts`), the line budget. The
capture scripts persist that to a fixture for `freeze`; `demo-cli.ts`
prints it to stdout for `vhs`. Both paths render through the same code,
so the video and the screenshots can't quietly diverge.

`demo.tape` aliases `websearch` / `webfetch` to `demo-cli.ts`, so the
command you see typed in the video is the tool's real name running the
real implementation over the real network — nothing is replayed or
staged. The `--limit` / `--max-chars` flags it types are genuine tool
parameters, present because the tools' defaults overflow 720p and would
scroll the `✓` header off the top of the frame. See
[The row budget](#the-row-budget) for the check that enforces this.

## When to regenerate

**Any asset:**

- Output format changed (header layout, sanitization, ANSI role usage)
- You want to swap fonts/theme/dimensions — these live in **two**
  places, `freeze.json` and the `Set` block in `demo.tape`. Change both
  and regen everything, or the card and the README screenshots stop
  looking like one set.

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

**Video only:**

- The pacing feels wrong, or a command now takes long enough that the
  `Sleep` beats leave dead air
- `regen.sh` warns that a segment reached the row budget. Lower a flag
  before the check starts to fail. See
  [The row budget](#the-row-budget)

## Regen

Prereqs:

- [`freeze`](https://github.com/charmbracelet/freeze) on PATH
  (`brew install charmbracelet/tap/freeze`)
- [`ddgr`](https://github.com/jarun/ddgr) on PATH (`brew install ddgr`)
- [`pngquant`](https://pngquant.org/) on PATH (`brew install pngquant` /
  `apt install pngquant`) — lossy palette quantize, takes the raw
  freeze output from ~450KB to ~50KB with no perceptible loss on
  terminal screenshots
- [`vhs`](https://github.com/charmbracelet/vhs) on PATH
  (`brew install vhs` — pulls `ttyd` and `ffmpeg`) — video only
- The **JetBrainsMono Nerd Font Mono** family installed
  (`brew install --cask font-jetbrains-mono-nerd-font`) — video only.
  `freeze` fetches its own webfont; `vhs` renders through a real
  browser and can only use installed families. If it's missing, VHS
  does not error — it falls back to a proportional face and the render
  comes out grotesquely letter-spaced. `regen.sh` checks up front.
- Node ≥ 20

The scripts import `.ts` source directly (e.g. `../../src/websearch.ts`,
`../../src/webfetch.ts`). `tsx` resolves those imports; plain `node`
(even with `--experimental-strip-types`) does not, because the imports
use the `.ts` extension rather than a `.js` shim.

```bash
# PNGs:  capture → freeze → freshness check → pngquant → size floor
# Video: preflight (font, tools, websearch+webfetch liveness, row
#        budget) → vhs → freshness check → faststart re-mux →
#        geometry/codec/duration/size checks
# Exits non-zero if any step fails or a renderer leaves a stale asset.
.github/preview/regen.sh                # everything (default)
.github/preview/regen.sh websearch      # just the websearch PNG
.github/preview/regen.sh webfetch       # just the webfetch PNG
.github/preview/regen.sh video          # just the MP4

# Default-everything is the right answer after a formatter change or a
# freeze.json/demo.tape edit. Single-target runs exist for when one URL
# is transiently flaky and you don't want a network blip blocking the
# other refreshes, and because the video takes ~40s.

git add .github/preview/websearch-output.ans .github/preview.png \
        .github/preview/webfetch-output.ans .github/webfetch.png \
        .github/preview.mp4
git commit -m "chore(preview): refresh assets"
```

The freshness checks are what prevent the silent-failure mode where
`freeze` or `vhs` exits 0 without writing — don't replace the script
with bare renderer invocations in CI or muscle memory. The PNGs compare
against their `.ans` fixture, which the same run just rewrote. The video
has no such input (`demo.tape` is a committed static file that any stale
MP4 is already newer than), so it compares against a marker stamped
immediately before `vhs` runs.

### The row budget

At 720p with this font the terminal holds only so many rows, including
the typed command and the trailing prompt. Both tools' defaults exceed
what's left for output, which is why `demo.tape` passes `--limit 2` and
`--max-chars 900`.

The numbers live in exactly one place: `row_budget`, `row_warn`, and
`wrap_cols` at the top of the video block in `regen.sh`. They are
measured at the tape's frame, not derived from it — `Set Width` is a
pixel value, and pixels-to-columns depends on the font's advance width.
Read them there rather than trusting a copy.

No check on the finished MP4 can find an overflow. A frame that lost its
`✓` header renders correctly, and it passes the geometry, codec,
duration, and size checks. `regen.sh` therefore measures the height
*before* it records. The preflight reads the two `Type … Enter` lines
from the tape, runs them, and counts the wrapped rows:

- **above `row_budget`** — the run fails, and names the tape line to edit
- **at or above `row_warn`** — the run warns. The output fits, but the
  content is live. One longer result title can overflow the next regen
- **below `row_warn`** — the run continues

The budget applies only to the frame it was measured at. The preflight
therefore also asserts that the tape still declares the same font size,
line height, width, height, and padding. Measure the budget again by
hand if you change the frame:

```bash
w=$(sed -nE 's/^ *wrap_cols=([0-9]+).*/\1/p' .github/preview/regen.sh)
npx -y tsx .github/preview/demo-cli.ts websearch "pi coding agent" --limit 2 \
  | awk -v w="$w" '{gsub(/\x1b\[[0-9;]*m/,""); n=length($0);
                    t += (n==0 ? 1 : int((n-1)/w)+1)} END{print t" rows"}'
```

Continue to watch the MP4 for the items no check covers: the pacing, dead
air, and whether the cards read well. You no longer need to watch it for
an overflow.

## Why a fixture file?

Captured output is committed so the PNG render is reproducible without
network and stable across reruns. Re-capture only when output format
or query results have meaningfully changed.

The video has no equivalent fixture — `vhs` drives a live terminal, so
a recording is inherently a live run. That's the trade for showing real
commands executing rather than a replay. It also means a regen can
capture a bad moment: an empty DuckDuckGo response (rate limiting)
renders a card that advertises a search tool that finds nothing. A result
set that is too tall scrolls the `✓` header away. Both records look
correct, and both pass every check on the finished MP4. The preflight
prevents this. It runs both commands before `vhs` does. At that point
`renderWebsearch` can still fail on an empty result set, and the script
can still count the rows.
