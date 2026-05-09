#!/usr/bin/env bash
# Regenerate .github/preview.png from a fresh ddgr capture.
#
# Why a script (not just doc steps): `freeze` can fail silently and
# leave a stale PNG paired with a fresh fixture. This script enforces
# the chain by exit code + a freshness check (PNG must be newer than
# the fixture it was rendered from), so a partial regen fails loudly
# instead of waiting to be eyeballed at review time.
#
# Prereqs:
#   - freeze   (https://github.com/charmbracelet/freeze)
#   - ddgr     (https://github.com/jarun/ddgr)
#   - pngquant (brew install pngquant / apt install pngquant)
#   - Node >= 20 with npx available
#
# Usage:
#   .github/preview/regen.sh

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

fixture="$here/websearch-output.ans"
png="$repo/.github/preview.png"
config="$here/freeze.json"

cd "$repo"

echo "[1/3] capture: refreshing $fixture"
npx -y tsx "$here/capture.ts"

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
echo
echo "Next:"
echo "  git add $fixture $png"
echo "  git commit -m 'chore(gallery): refresh preview asset'"
