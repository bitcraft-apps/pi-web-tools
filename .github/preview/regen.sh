#!/usr/bin/env bash
# Regenerate .github/preview.png and/or .github/webfetch.png from
# fresh captures.
#
# Why a script (not just doc steps): `freeze` can fail silently and
# leave a stale PNG paired with a fresh fixture. This script enforces
# the chain by exit code + a freshness check (PNG must be newer than
# the fixture it was rendered from), so a partial regen fails loudly
# instead of waiting to be eyeballed at review time.
#
# Prereqs:
#   - freeze   (https://github.com/charmbracelet/freeze)
#   - ddgr     (https://github.com/jarun/ddgr)              — websearch only
#   - pandoc   (or w3m, https://pandoc.org)                 — webfetch only
#   - pngquant (brew install pngquant / apt install pngquant)
#   - Node >= 20 with npx available
#
# Usage:
#   .github/preview/regen.sh                # both tools
#   .github/preview/regen.sh websearch      # just websearch
#   .github/preview/regen.sh webfetch       # just webfetch

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

# Pick which tools to regen based on the optional first arg. Default
# is "both" — the common case after a formatter change. Explicit
# single-tool runs exist for when one URL is flaky (e.g. Wikipedia
# briefly unreachable) and you don't want a network blip blocking the
# other tool's refresh.
case "${1:-}" in
  "")          tools=("${all_tools[@]}") ;;
  websearch)   tools=("${all_tools[0]}") ;;
  webfetch)    tools=("${all_tools[1]}") ;;
  *)
    echo "ERROR: unknown tool '$1'. Expected: websearch | webfetch | (no arg = both)." >&2
    exit 2
    ;;
esac

regenerated=()

for tuple in "${tools[@]}"; do
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

echo
echo "Next:"
echo "  git add ${regenerated[*]}"
echo "  git commit -m 'chore(preview): refresh assets'"
