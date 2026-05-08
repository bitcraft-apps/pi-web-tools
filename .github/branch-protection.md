# Branch protection

This file documents the branch-protection settings configured in GitHub's UI.
It is **descriptive, not authoritative** — the source of truth lives in
`Settings → Branches` on github.com. Update this file in the same PR as any
change to those settings.

## Protected branches

- `main`

## Required status checks on `main`

The following check names must pass before a PR can be merged. They are
copy-pasted verbatim from the GitHub branch-protection UI:

- `vitest (bun)` — produced by `.github/workflows/test.yml` (job `test`, `name: vitest (bun)`)
- `Lint PR title (Conventional Commits)` — produced by `.github/workflows/pr-title.yml` (job `lint`, `name: Lint PR title (Conventional Commits)`)

## ⚠️ Renaming a workflow or job breaks the required-check binding

GitHub matches required checks by their **display name** (workflow `name:` +
job `name:`), not by file path or job ID. Renaming either field — even
cosmetically — silently de-registers the old name from branch protection:
the new check runs, but it isn't required, and the old required check never
reports, so PRs either merge without gating or block forever waiting on a
check that will never arrive.

If you rename a workflow `name:` or a job `name:` field, the same PR must:

1. Update this file with the new check name(s).
2. Be coordinated with a repo admin who updates the branch-protection
   required-checks list in the GitHub UI **at merge time** (remove the old
   name, add the new one).
