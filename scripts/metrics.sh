#!/usr/bin/env bash
#
# scripts/metrics.sh — passive health signals for @bitcraft-apps/pi-web-tools.
#
# Run on demand:
#
#   bash scripts/metrics.sh
#
# No state, no cache, no scraping. Each section runs in its own pipeline; one
# failed signal prints `_skipped: …_` and the rest of the report still renders
# (intentional: `set -u` but no `set -e`).
#
# Requires: curl, jq, gh (authenticated). All already in the project's dev env.
#
# See issue #158 for scope rationale.

set -u

PKG="@bitcraft-apps/pi-web-tools"
PKG_ENC="@bitcraft-apps%2Fpi-web-tools"
REPO="bitcraft-apps/pi-web-tools"

# `date -v-30d` is BSD (macOS); `date -d "-30 days"` is GNU (Linux). Try both.
SINCE_30D="$(date -v-30d +%F 2>/dev/null || date -d '-30 days' +%F)"

section() { printf '\n## %s\n\n' "$1"; }
skipped() { printf '_skipped: %s_\n' "$1"; }

printf '# pi-web-tools metrics — %s\n' "$(date +%F)"

# ── 1. npm downloads, last week, by version ──────────────────────────────────
section "npm downloads — last week, by version"
curl -fsS "https://api.npmjs.org/versions/${PKG_ENC}/last-week" \
  | jq -r '.downloads | to_entries | sort_by(.value) | reverse
           | (["downloads","version"], (.[] | [.value, .key])) | @tsv' \
  || skipped "npm versions API"

# ── 2. npm downloads, daily, last 30d ────────────────────────────────────────
section "npm downloads — daily, last 30d"
curl -fsS "https://api.npmjs.org/downloads/range/last-month/${PKG}" \
  | jq -r '(["day","downloads"], (.downloads[] | [.day, .downloads])) | @tsv' \
  || skipped "npm downloads range API"

# ── 3. GitHub stars (current) ────────────────────────────────────────────────
section "GitHub stars"
gh api "repos/${REPO}" --jq '.stargazers_count' \
  || skipped "gh api repos/${REPO}"

# ── 4. GitHub traffic (14d rolling window, owner-only) ───────────────────────
section "GitHub traffic — 14d rolling"

printf '\n### clones\n\n'
gh api "repos/${REPO}/traffic/clones" \
    --jq '"total: \(.count) clones, \(.uniques) uniques"' \
  || skipped "gh api traffic/clones"

printf '\n### views\n\n'
gh api "repos/${REPO}/traffic/views" \
    --jq '"total: \(.count) views, \(.uniques) uniques"' \
  || skipped "gh api traffic/views"

printf '\n### top referrers\n\n'
gh api "repos/${REPO}/traffic/popular/referrers" \
    --jq '(["count","uniques","referrer"], (.[] | [.count, .uniques, .referrer])) | @tsv' \
  || skipped "gh api traffic/popular/referrers"

printf '\n### top paths\n\n'
gh api "repos/${REPO}/traffic/popular/paths" \
    --jq '(.[] | [.count, .uniques, .path]) | @tsv' \
  || skipped "gh api traffic/popular/paths"

# ── 5. Issues + PRs created in the last 30d ──────────────────────────────────
section "Issues + PRs created since ${SINCE_30D}"
gh search issues \
    --repo "${REPO}" \
    --created ">=${SINCE_30D}" \
    --json number,isPullRequest \
    --jq 'group_by(.isPullRequest)
          | .[]
          | "\(if .[0].isPullRequest then "PRs" else "issues" end): \(length)"' \
  || skipped "gh search issues"
