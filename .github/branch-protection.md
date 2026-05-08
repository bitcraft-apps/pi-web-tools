# Branch protection

This file documents the branch-protection settings configured in GitHub's UI.
It is **descriptive, not authoritative** — the source of truth lives in
`Settings → Branches` on github.com. Update this file in the same PR as any
change to those settings.

## Protected branches

- `main`

## Required status checks on `main`

The following check names must pass before a PR can be merged. They are
copy-pasted verbatim from the GitHub branch-protection UI. GitHub renders
multi-job workflow checks as `<workflow name> / <job id>` (or `<job name>`
if set), which is why the job id matters for the binding — see the warning
below.

- `ci / checks` — produced by `.github/workflows/ci.yml`
- `Lint PR title (Conventional Commits)` — produced by `.github/workflows/pr-title.yml`

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
