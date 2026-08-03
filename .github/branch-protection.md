# Branch protection

This file documents the branch-protection settings configured in GitHub's UI.
It is **descriptive, not authoritative** — the source of truth lives in
`Settings → Branches` on github.com. Update this file in the same PR as any
change to those settings.

## Protected branches

- `main`

## Required status checks on `main`

The following check names must pass before a PR can be merged. They are the
check-run names as stored by the API (`gh api
repos/bitcraft-apps/pi-web-tools/branches/main/protection`), which is the bare
job `name:` — or the job id when `name:` is unset. The UI displays them with the
workflow name alongside; the workflow name is not part of the match key — see
the warning below.

- `ci-gate` — produced by `.github/workflows/ci.yml`
- `contract` — produced by `.github/workflows/contract.yml`
- `Lint PR title (Conventional Commits)` — produced by `.github/workflows/pr-title.yml`

## Admin enforcement and reviews

`enforce_admins` is **on**, and `required_approving_review_count` is **0**. Both
are deliberate; neither is an oversight.

Admin enforcement is on even though this is a single-maintainer repo. Its purpose
isn't to police a second person — there isn't one — it's to make sure an
accidental `git push` to `main`, or a bypass taken in a hurry, can't put
unchecked code on the default branch. The maintainer goes through a PR and waits
for the same gates as anyone else.

Zero required approvals is what lets the repo function at all. With one
maintainer there is nobody to approve a PR, and GitHub won't let an author
approve their own, so any non-zero count would deadlock every change. The gate
here is CI, not a second pair of eyes: `ci-gate` (see below), `contract`, and the
PR-title lint must all pass, on top of `required_linear_history`,
`required_conversation_resolution`, and no force pushes or branch deletions.

Two consequences worth knowing before they surprise you:

- `strict: true` now applies to the maintainer too. A PR whose branch is behind
  `main` needs **Update branch** before the merge button unlocks.
- If a required check is itself broken and blocking the very fix that repairs it,
  the move is to turn `enforce_admins` off, merge, and turn it straight back on.
  That's a visible, auditable toggle — deliberately not the same thing as leaving
  a standing bypass in place.

`dismiss_stale_reviews` is `true` but inert while the required review count is 0.
It's left enabled so it starts working on its own if a second maintainer is ever
added, rather than becoming something to remember. It is not a misconfiguration.

## Why `ci-gate` and not the individual `ci.yml` jobs

`ci.yml`'s real coverage is the `node-matrix` job: a `node` × `undici` matrix
that exercises every pairing this package claims to support, because a bad
pairing silently disables the connect-time SSRF guard. Its check-run names are
derived from the matrix values (`node 24 / undici 8`), and `ci.yml` instructs
maintainers to change those values as majors enter and leave support.

Requiring those names directly would break on exactly the edit the workflow asks
for: adding a major mints check names that are not in the required list (the new
cells are advisory the day they land), and dropping an EOL major leaves a
required context that never reports again, blocking every PR as pending until
someone edits repository settings.

So `ci-gate` aggregates `checks` and `node-matrix` via `needs:` and reports one
name-stable result. `checks` is deliberately *not* required on its own — the
gate covers it, and every extra name is one more binding to repo settings.
Adding or removing a matrix axis value requires no branch-protection change.

`needs:` cannot cross workflows, so `contract` stays its own required check. If
`contract.yml` ever grows a matrix, it needs its own gate job by this pattern.

## ⚠️ Renaming a job breaks the required-check binding

GitHub matches required checks by their **check-run name**, which is the
job's `name:` field (or the job ID if `name:` is unset). The workflow
`name:` and the workflow filename are not part of the match key. Renaming
a job's `name:` — even cosmetically — silently de-registers the old name
from branch protection: the new check runs but isn't required, and the old
required check never reports, so PRs either merge without gating or block
forever waiting on a check that will never arrive.

If you rename a job's `name:` (or its ID, when `name:` is unset), the same
PR must:

1. Update this file with the new check name(s).
2. Be coordinated with a repo admin who updates the branch-protection
   required-checks list in the GitHub UI **before the PR is merged** —
   ideally by adding the new name to the required list first, so the rename
   PR is itself gated by the new check, then removing the old name once no
   open PR still reports it. Updating protection only at merge time leaves
   a window where `main` has no gate.
