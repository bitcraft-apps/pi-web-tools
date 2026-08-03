#!/usr/bin/env bash
# Regenerate the gallery/README preview assets: .github/preview.png,
# .github/webfetch.png, and .github/preview.mp4.
#
# Why a script (not just doc steps): `freeze` and `vhs` can both fail
# silently and leave a stale asset paired with a fresh input. This
# script enforces the chain by exit code + a freshness check (the asset
# must be newer than the input it was rendered from), so a partial
# regen fails loudly instead of waiting to be eyeballed at review time.
# The video path also measures the row budget before it records. Output
# that is too tall scrolls the `✓` header off the top. Such a frame still
# passes the geometry, codec, duration, and size checks, so the finished
# MP4 cannot report this failure. Measure the height first instead.
#
# Prereqs:
#   - freeze   (https://github.com/charmbracelet/freeze)     — PNGs only
#   - pngquant (brew install pngquant / apt install pngquant) — PNGs only
#   - vhs      (brew install vhs; pulls ttyd + ffmpeg)        — video only
#   - ddgr     (https://github.com/jarun/ddgr)                — websearch, video
#   - pandoc   (or w3m, https://pandoc.org)                   — webfetch, video
#   - Node >= 20 with npx available
#
# Usage:
#   .github/preview/regen.sh                # everything
#   .github/preview/regen.sh websearch      # just the websearch PNG
#   .github/preview/regen.sh webfetch       # just the webfetch PNG
#   .github/preview/regen.sh video          # just the MP4

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
config="$here/freeze.json"

cd "$repo"

# Tool definitions: name|capture script|fixture path|png path
# Both PNGs use the same freeze.json so the README screenshots render
# in matching frames. See spec §"Decisions" #6.
all_tools=(
  "websearch|$here/capture-websearch.ts|$here/websearch-output.ans|$repo/.github/preview.png"
  "webfetch|$here/capture-webfetch.ts|$here/webfetch-output.ans|$repo/.github/webfetch.png"
)

# Pick what to regen based on the optional first arg. Default is
# everything — the common case after a formatter change. Explicit
# single-target runs exist for when one URL is flaky (e.g. Wikipedia
# briefly unreachable) and you don't want a network blip blocking the
# other refreshes, and because the video takes ~40s while the PNGs are
# near-instant.
do_video=0
case "${1:-}" in
  "")          tools=("${all_tools[@]}"); do_video=1 ;;
  websearch)   tools=("${all_tools[0]}") ;;
  webfetch)    tools=("${all_tools[1]}") ;;
  video)       tools=() ;                do_video=1 ;;
  *)
    echo "ERROR: unknown target '$1'. Expected: websearch | webfetch | video | (no arg = all)." >&2
    exit 2
    ;;
esac

regenerated=()

# `${tools[@]+…}` guard: `regen.sh video` leaves tools empty, and bash
# 3.2 (still the macOS system bash) treats an unset empty array as an
# unbound variable under `set -u`.
for tuple in ${tools[@]+"${tools[@]}"}; do
  IFS='|' read -r name capture fixture png <<<"$tuple"

  echo
  echo "==> $name"

  echo "[1/4] capture: refreshing $fixture"
  npx -y tsx "$capture"

  echo "[2/4] freeze: rendering $png"
  freeze --config "$config" --output "$png" "$fixture"

  echo "[3/4] verify: PNG must be newer than fixture (freeze can fail silently)"
  if [ ! -f "$png" ]; then
    echo "ERROR: $png does not exist after freeze." >&2
    exit 1
  fi
  if [ ! "$png" -nt "$fixture" ]; then
    echo "ERROR: $png is not newer than $fixture." >&2
    echo "       freeze likely exited 0 without writing the PNG." >&2
    exit 1
  fi

  # Terminal screenshots have a tiny effective palette (background, text,
  # 5 ANSI colors). freeze emits 8-bit RGBA at ~450KB; pngquant takes that
  # to ~50KB with no perceptible loss at this size. quality=80-95 means
  # "refuse the result if we can't hit 80% min" — belt-and-braces against
  # a future render that doesn't quantize well.
  echo "[4/4] optimize: pngquant"
  before=$(stat -f '%z' "$png" 2>/dev/null || stat -c '%s' "$png")
  pngquant --quality=80-95 --speed 1 --strip --force --output "$png" -- "$png"
  after=$(stat -f '%z' "$png" 2>/dev/null || stat -c '%s' "$png")
  echo "ok: $before → $after bytes"

  # Sanity floor: if the optimized PNG ever balloons past 200KB, something
  # changed (palette explosion, larger dimensions, font swap) and the
  # README/gallery thumbnail will get sluggish to load. Fail loudly.
  if [ "$after" -gt 204800 ]; then
    echo "ERROR: $png is ${after} bytes (>200KB)." >&2
    echo "       Investigate before committing — the previous baseline" >&2
    echo "       was ~50KB. Likely causes: dimensions changed, more" >&2
    echo "       colors in output, or pngquant misbehaving." >&2
    exit 1
  fi

  regenerated+=("$fixture" "$png")
done

if [ "$do_video" -eq 1 ]; then
  tape="$here/demo.tape"
  mp4="$repo/.github/preview.mp4"
  # Mirrors `Set FontFamily` in demo.tape.
  font="JetBrainsMono Nerd Font Mono"

  # Row budget. The frame holds ~21 rows. That count includes the typed
  # command and the trailing prompt. More than 19 rows of output pushes
  # the `✓` header off the top. The header is the line that tells the
  # viewer which tool ran.
  #
  # These values are measured at the geometry asserted below. They are
  # not derived from it: `Set Width 1280` is pixels, and the pixels to
  # columns ratio depends on the font advance width. Measure the values
  # again if the frame changes. See README §"The row budget".
  row_budget=19   # more than this: the output scrolls, so fail
  row_warn=18     # this or more: the output fits, but with no headroom
  wrap_cols=120   # effective columns at Width 1280 and Padding 40

  echo
  echo "==> video"

  # VHS renders through a headless browser and can only use *installed*
  # font families. A missing family doesn't error — it silently falls
  # back to a proportional face and the render comes out grotesquely
  # letter-spaced, which is only obvious if you actually watch the
  # result. Check up front where the fix is one brew command.
  # (fc-list is fontconfig; if it isn't installed we can't check, and a
  # warning beats refusing to run.)
  echo "[1/5] preflight: font, tools, liveness, row budget"
  if command -v fc-list >/dev/null 2>&1; then
    # Substring match via `case`, not `… | grep -q`: under `set -o
    # pipefail`, grep -q exits at the first match, fc-list dies on
    # SIGPIPE (141), and the pipeline reports failure even though the
    # font was found.
    installed_families=$(fc-list : family)
    case "$installed_families" in
      *"$font"*) ;;
      *)
        echo "ERROR: font '$font' is not installed." >&2
        echo "       VHS would silently fall back and render garbage spacing." >&2
        echo "       Fix: brew install --cask font-jetbrains-mono-nerd-font" >&2
        exit 1
        ;;
    esac
  else
    echo "warn: fc-list not found; skipping font check. If the render looks"
    echo "      letter-spaced, '$font' is missing."
  fi
  for bin in vhs ffmpeg ffprobe; do
    command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: $bin not on PATH." >&2; exit 1; }
  done

  # The row budget above applies only to the frame it was measured at.
  # The tape holds that frame. Assert the values instead of deriving
  # them. A change to the geometry then fails here, and the maintainer
  # must measure the budget again.
  for expect in "Set Width 1280" "Set Height 720" "Set Padding 40"; do
    if ! grep -qx -- "$expect" "$tape"; then
      echo "ERROR: demo.tape no longer says '$expect'." >&2
      echo "       row_budget/wrap_cols in this script were measured at that" >&2
      echo "       geometry. Re-measure them before changing the frame." >&2
      exit 1
    fi
  done

  # Get the command that the video types. Read it from the tape instead
  # of repeating it here. The probe then measures the recorded command
  # exactly, with its query, URL, and flag values. This also keeps
  # `--limit` and `--max-chars` in one place.
  #
  # The pattern matches the two visible `Type … Enter` lines. It does not
  # match the `Hide` block's `Type "alias websearch=…"`, because no
  # command name follows the opening quote there.
  tape_cmd() {
    sed -nE "s/^Type [\"\`]($1 .*)[\"\`] Enter[[:space:]]*\$/\1/p" "$tape"
  }

  # These functions mirror demo.tape's aliases, so an extracted line runs
  # without a change.
  websearch() { npx -y tsx "$here/demo-cli.ts" websearch "$@"; }
  webfetch() { npx -y tsx "$here/demo-cli.ts" webfetch "$@"; }

  # Liveness and row budget, one call per segment of the tape.
  #
  # Liveness: VHS ignores the exit code of the commands in the tape. A
  # rate-limited ddgr records a card that says "no results". A missing
  # pandoc records a frame of stack trace. Both still pass every check
  # below. renderWebsearch fails on an empty result set, and
  # renderWebfetch fails if the URL returns 404 or pandoc and w3m are not
  # on PATH. Run them first, and these failures become loud.
  #
  # Row budget: the output is here, so also count its height. No check on
  # the finished MP4 can find this failure. The row count also depends on
  # the content, which is live. One longer result title can push a
  # segment that passed before above the budget.
  probe_segment() {
    local name why cmd out rows
    name="$1"
    why="$2"

    cmd=$(tape_cmd "$name")
    # An empty result means the tape no longer matches the tape_cmd
    # pattern. Do not continue without the measurement. A silent skip is
    # the failure this check must prevent.
    if [ -z "$cmd" ]; then
      echo "ERROR: no typed '$name' line found in demo.tape." >&2
      echo "       Expected a line like: Type \"$name …\" Enter" >&2
      echo "       Update tape_cmd() to match the tape — do not leave the" >&2
      echo "       row budget unmeasured." >&2
      exit 1
    fi

    echo "      probing: $cmd"
    echo "        ($why)"
    out=$(eval "$cmd")

    # The measurement from README §"The row budget". Remove the SGR
    # codes, then count the rows each logical line wraps to. Note that
    # `length()` counts characters in a UTF-8 locale, but bytes in the C
    # locale. A line of multi-byte glyphs near a wrap boundary can
    # therefore count one row too high. Both locales agree on the current
    # content, and the warning tier gives a margin for this difference.
    rows=$(printf '%s\n' "$out" | awk -v w="$wrap_cols" \
      '{gsub(/\x1b\[[0-9;]*m/,""); n=length($0);
        t += (n==0 ? 1 : int((n-1)/w)+1)} END{print t+0}')

    if [ "$rows" -gt "$row_budget" ]; then
      echo "ERROR: $name renders $rows rows. The budget is $row_budget." >&2
      echo "       The frame holds ~21 rows, including the typed command and" >&2
      echo "       the trailing prompt. This output scrolls the ✓ header off" >&2
      echo "       the top. The geometry, codec, duration, and size checks" >&2
      echo "       below cannot find that." >&2
      echo "       Fix: lower the flag on this demo.tape line:" >&2
      echo "         $cmd" >&2
      exit 1
    elif [ "$rows" -ge "$row_warn" ]; then
      echo "      warn: $rows rows, budget $row_budget. No headroom left."
      echo "            The content is live. One longer line overflows the frame."
    else
      echo "      ok: $rows rows (budget $row_budget)"
    fi
  }

  probe_segment websearch "a rate-limited search would record an empty card"
  probe_segment webfetch "a missing pandoc/w3m would record a stack trace"

  # Scratch space for the freshness marker and the faststart re-mux.
  # Both used to live next to the asset in .github/, where an ffmpeg
  # failure left the temp file behind one `git add .github` from being
  # committed.
  video_tmp=$(mktemp -d)
  trap 'rm -rf "$video_tmp"' EXIT

  echo "[2/5] vhs: rendering $mp4"
  # Freshness reference. Not the tape: it's a committed static file, so a
  # stale MP4 from an earlier regen is always newer than it and sails
  # through the check below. (The PNG path can compare against its
  # fixture because that fixture is rewritten in the same run.) Stamp a
  # marker immediately before vhs instead, so the check asks the question
  # we actually mean: did *this* run write the video?
  marker="$video_tmp/marker"
  touch "$marker"
  vhs "$tape"

  echo "[3/5] verify: MP4 must be newer than this run's marker (vhs can fail silently)"
  if [ ! -f "$mp4" ]; then
    echo "ERROR: $mp4 does not exist after vhs." >&2
    exit 1
  fi
  if [ ! "$mp4" -nt "$marker" ]; then
    echo "ERROR: $mp4 was not written by this run." >&2
    echo "       vhs likely exited 0 without writing the video, leaving" >&2
    echo "       the previous MP4 in place." >&2
    exit 1
  fi

  # The gallery streams this over HTTP and starts playing on hover. VHS
  # leaves the moov atom at the end of the file, so playback can't begin
  # until the whole thing downloads. Re-mux (no re-encode) to move it to
  # the front. Cheap and idempotent.
  echo "[4/5] ffmpeg: moving moov atom to the front (faststart)"
  tmp_mp4="$video_tmp/faststart.mp4"
  ffmpeg -v error -y -i "$mp4" -c copy -movflags +faststart "$tmp_mp4"
  mv "$tmp_mp4" "$mp4"

  echo "[5/5] verify: geometry, codec, duration, size"
  probe=$(ffprobe -v error \
    -show_entries stream=width,height,codec_name,pix_fmt \
    -show_entries format=duration \
    -of default=nw=1:nk=0 "$mp4")
  # 1280x720 keeps the card in the same 16:9 frame as the PNGs.
  # h264/yuv420p is the combination Safari and Chrome will both play —
  # yuv444p renders fine in ffplay and shows a black box in Safari.
  for expect in "width=1280" "height=720" "codec_name=h264" "pix_fmt=yuv420p"; do
    if ! printf '%s\n' "$probe" | grep -qx "$expect"; then
      echo "ERROR: expected $expect. ffprobe said:" >&2
      printf '%s\n' "$probe" >&2
      exit 1
    fi
  done

  # Duration band, not an exact value: the tape's Sleeps are fixed but
  # ddgr/Wikipedia latency isn't. Outside this band means the tape
  # changed or a command died early and left dead air.
  duration=$(printf '%s\n' "$probe" | sed -nE 's/^duration=([0-9]+).*/\1/p')
  # ffprobe reports `duration=N/A` for a container it can't measure (a
  # truncated write, a missing moov atom). The sed above yields empty
  # there, and `[ "" -lt 12 ]` dies with "integer expression expected"
  # instead of anything a reader can act on.
  if [ -z "$duration" ]; then
    echo "ERROR: ffprobe reported no usable duration for $mp4." >&2
    echo "       Usually a truncated or malformed container. ffprobe said:" >&2
    printf '%s\n' "$probe" >&2
    exit 1
  fi
  if [ "$duration" -lt 12 ] || [ "$duration" -gt 45 ]; then
    echo "ERROR: duration is ${duration}s, expected 12–45s." >&2
    echo "       Too short usually means a command failed and Wait returned" >&2
    echo "       immediately; too long means a Sleep or the tape grew." >&2
    exit 1
  fi

  # Sanity ceiling, same idea as the PNGs' 200KB floor. Low-motion 720p
  # terminal content encodes to ~150KB; a blowout means dimensions,
  # framerate, or content volume changed.
  size=$(stat -f '%z' "$mp4" 2>/dev/null || stat -c '%s' "$mp4")
  if [ "$size" -gt 3145728 ]; then
    echo "ERROR: $mp4 is ${size} bytes (>3MB)." >&2
    echo "       Investigate before committing — the baseline was ~150KB." >&2
    exit 1
  fi
  echo "ok: ${duration}s, ${size} bytes"

  regenerated+=("$mp4")

  # What the mechanical checks do not cover. The preflight row budget now
  # covers overflow. No check can measure the pacing, or tell you if the
  # cards read well.
  echo
  echo "Watch the result before you commit. Check the pacing for dead air or"
  echo "a Sleep that is now wrong. Check that both cards still read well."
fi

echo
echo "Next:"
echo "  git add ${regenerated[*]:-}"
echo "  git commit -m 'chore(preview): refresh assets'"
