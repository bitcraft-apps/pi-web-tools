#!/usr/bin/env bash
#
# scripts/metrics.sh — passive health signals for @bitcraft-apps/pi-web-tools,
# plus drift signals for the pi platform underneath it (section 6).
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

# Upstream package whose bundled versions we mirror in devDependencies.
PI_PKG="@earendil-works/pi-coding-agent"

# devDeps we pin deliberately to match what PI_PKG bundles, so the dev tree
# tests the same code the runtime executes. Checked for exact equality below.
MIRRORED_DEVDEPS='["typebox"]'

# A declared dep that has not published in this long is treated as a signal,
# not a fact: it usually means renamed, re-scoped, or abandoned.
STALE_DAYS=60

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# `date -v-30d` is BSD (macOS); `date -d "-30 days"` is GNU (Linux). Try both.
SINCE_30D="$(date -v-30d +%F 2>/dev/null || date -d '-30 days' +%F)"

section() { printf '\n## %s\n\n' "$1"; }
skipped() { printf '_skipped: %s_\n' "$1"; }

# Emit one TSV drift row for a declared dependency: name, declared range,
# registry latest, its publish date, and a status verdict.
#
# Only two verdicts are automatic, because only two are unambiguous without
# a real semver implementation:
#   MISSING — the name does not exist on the registry at all
#   STALE   — nothing published in > STALE_DAYS
# Anything else prints declared and latest side by side for a human to judge.
# Deliberately no range-satisfaction logic here; see the section comment.
drift_row() {
  local name="$1" declared="$2" enc resp code body
  enc="${name//\//%2F}"

  # -w appends the status line so we get body and code from one request
  # without a temp file (the script keeps its no-state promise).
  resp="$(curl -sS -w '\n%{http_code}' "https://registry.npmjs.org/${enc}" 2>/dev/null)"
  code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"

  if [ "$code" = "404" ]; then
    printf '%s\t%s\t—\t—\tMISSING — not on npm (renamed or unpublished?)\n' "$name" "$declared"
    return
  fi
  if [ "$code" != "200" ]; then
    printf '%s\t%s\t?\t?\tskipped — registry HTTP %s\n' "$name" "$declared" "${code:-no response}"
    return
  fi

  # Dates are computed in jq via `now` rather than in shell, so this needs no
  # BSD/GNU `date` dance. npm timestamps carry fractional seconds, which
  # fromdateiso8601 rejects — strip them first.
  printf '%s' "$body" \
    | jq -r --arg name "$name" --arg declared "$declared" --argjson stale "$STALE_DAYS" '
        (.["dist-tags"].latest) as $v
        | (.time[$v] | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) as $published
        | (((now - $published) / 86400) | floor) as $age
        | [ $name, $declared, $v, (.time[$v] | .[0:10]),
            (if $age > $stale
             then "STALE — no publish in \($age)d"
             else "ok — published \($age)d ago"
             end) ]
        | @tsv' \
    || printf '%s\t%s\t?\t?\tskipped — could not parse packument\n' "$name" "$declared"
}

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

# ── 6. Upstream drift — the pi platform ──────────────────────────────────────
section "upstream drift — pi platform"

# Every other section watches *this* package. This one watches the platform
# underneath it, because that is where the damage came from: pi re-scoped its
# npm packages from @mariozechner/* to @earendil-works/* in v0.74.0, and this
# repo kept pointing at the abandoned scope for three months (issue #162).
#
# Nothing errored the whole time. A re-scoped package keeps resolving from the
# registry and keeps working via pi's loader aliases — it just stops
# publishing. So silence is the signal here, not failure. That is what
# STALE_DAYS is for.
#
# No semver range-satisfaction check on purpose: doing it properly needs a real
# semver implementation, and doing it approximately in bash produces false
# confidence. Declared and latest are printed side by side; you judge.

printf '### declared peer deps\n\n'
{
  printf 'package\tdeclared\tlatest\tpublished\tstatus\n'
  jq -r '.peerDependencies // {} | to_entries[] | "\(.key)\t\(.value)"' "${ROOT}/package.json" \
    | while IFS=$'\t' read -r dep_name dep_range; do
        drift_row "$dep_name" "$dep_range"
      done
} || skipped "peer dep drift"

printf '\n### devDep pins mirroring pi bundled versions\n\n'

# Exact-equality check, unlike the peer rows above: these pins exist *only* to
# match what pi ships, so any difference is drift by definition. This is the
# check that would have caught typebox sitting at 1.1.38 in the dev tree while
# pi executed 1.3.7 (issue #162).
curl -fsS "https://registry.npmjs.org/${PI_PKG//\//%2F}/latest" 2>/dev/null \
  | jq -r --slurpfile pkg "${ROOT}/package.json" --argjson mirrored "$MIRRORED_DEVDEPS" '
      .version as $pi_version
      | .dependencies as $bundled
      | (($pkg[0].devDependencies) // {}) as $dev
      | "pi \($pi_version) bundles:",
        ( $mirrored[]
          | . as $dep
          | [ $dep,
              "declared \($dev[$dep] // "—")",
              "pi bundles \($bundled[$dep] // "—")",
              (if $dev[$dep] == null then "not pinned here"
               elif $bundled[$dep] == null then "pi no longer bundles it"
               elif $dev[$dep] == $bundled[$dep] then "ok"
               else "DRIFT — pinned \($dev[$dep]), pi bundles \($bundled[$dep])"
               end) ]
          | @tsv )' \
  || skipped "pi bundled-version lookup"
