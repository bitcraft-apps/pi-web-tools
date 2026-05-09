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
#   - freeze (https://github.com/charmbracelet/freeze)
#   - ddgr   (https://github.com/jarun/ddgr)
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

echo "[2/3] freeze: rendering $png"
freeze --config "$config" --output "$png" "$fixture"

echo "[3/3] verify: PNG must be newer than fixture (freeze can fail silently)"
if [ ! -f "$png" ]; then
  echo "ERROR: $png does not exist after freeze." >&2
  exit 1
fi
if [ ! "$png" -nt "$fixture" ]; then
  echo "ERROR: $png is not newer than $fixture." >&2
  echo "       freeze likely exited 0 without writing the PNG." >&2
  exit 1
fi

echo "ok: $(stat -f '%z' "$png" 2>/dev/null || stat -c '%s' "$png") bytes"
echo
echo "Next:"
echo "  git add $fixture $png"
echo "  git commit -m 'chore(gallery): refresh preview asset'"
